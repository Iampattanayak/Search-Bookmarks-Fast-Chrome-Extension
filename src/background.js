// BACKGROUND SERVICE WORKER

// Globals
let indexedBookmarks = [];
let userShortcuts = {};
let clickCounts = {};
const shortcutRegistry = new Set();

// ---------------------------------------------------------
//  INITIALIZATION & LISTENERS
// ---------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
    // Trigger index build. This will eventually call updateContextMenus.
    // We do NOT call create() here to avoid race conditions with updateContextMenus.
    buildIndex();
});

chrome.runtime.onStartup.addListener(loadData);

// Debounce listener events to avoid thrashing the service worker on bulk changes
let dbTimer;
const debouncedBuild = () => {
    clearTimeout(dbTimer);
    dbTimer = setTimeout(buildIndex, 500);
};

chrome.bookmarks.onCreated.addListener(debouncedBuild);
chrome.bookmarks.onRemoved.addListener(debouncedBuild);
chrome.bookmarks.onChanged.addListener(debouncedBuild);
chrome.bookmarks.onMoved.addListener(debouncedBuild);

// ---------------------------------------------------------
//  INDEXING LOGIC
// ---------------------------------------------------------

function loadData() {
    chrome.storage.local.get(['indexedBookmarks', 'userShortcuts', 'clickCounts'], (result) => {
        indexedBookmarks = result.indexedBookmarks || [];
        userShortcuts = result.userShortcuts || {};
        clickCounts = result.clickCounts || {};
        updateContextMenus(); // Update menus with fresh data
    });
}

function buildIndex() {
    chrome.bookmarks.getTree((tree) => {
        const flat = [];
        if (tree && tree[0]) {
            processNode(tree[0], '', flat);
        }

        assignShortcuts(flat);
        indexedBookmarks = flat;

        // Save to storage
        chrome.storage.local.set({ indexedBookmarks: flat }, () => {
            loadData();
        });
    });
}

function processNode(node, folderPath, results) {
    let currentPath = folderPath;
    if (node.title && node.id !== '0') {
        if (currentPath) currentPath += ' / ';
        currentPath += node.title;
    }

    if (node.url) {
        results.push({
            id: node.id,
            title: node.title,
            url: node.url,
            folderPath: folderPath,
            parentId: node.parentId,
            dateAdded: node.dateAdded,
            shortcut: ''
        });
    }

    if (node.children) {
        node.children.forEach(child => {
            processNode(child, node.url ? folderPath : currentPath, results);
        });
    }
}

function assignShortcuts(bookmarks) {
    shortcutRegistry.clear();
    bookmarks.forEach(bm => {
        if (userShortcuts[bm.id]) {
            bm.shortcut = userShortcuts[bm.id];
            shortcutRegistry.add(bm.shortcut);
        }
    });

    bookmarks.forEach(bm => {
        if (!bm.shortcut) {
            bm.shortcut = generateUniqueShortcut(bm.title);
        }
    });
}

function generateUniqueShortcut(title) {
    const base = title.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().substring(0, 3) || 'bm';
    let candidate = base;
    let counter = 1;
    while (shortcutRegistry.has(candidate)) {
        candidate = base + counter++;
    }
    shortcutRegistry.add(candidate);
    return candidate;
}

// ---------------------------------------------------------
//  CONTEXT MENUS logic
// ---------------------------------------------------------

function updateContextMenus() {
    // Robust removeAll to clear state
    chrome.contextMenus.removeAll(() => {
        if (chrome.runtime.lastError) { /* ignore */ }

        // Create Root
        chrome.contextMenus.create({
            id: "sb_root",
            title: "Save to Search Bookmarks Fast...",
            contexts: ["page"]
        }, () => {
            if (chrome.runtime.lastError) return; // Prevent cascade if root failed

            // 1. Calculate Folder Scores
            const folderScores = {};
            const folderIds = {};

            indexedBookmarks.forEach(bm => {
                const fName = bm.folderPath || 'Unsorted';
                const clicks = clickCounts[bm.id] || 0;
                folderScores[fName] = (folderScores[fName] || 0) + 1 + (clicks * 5);
                if (bm.parentId) folderIds[fName] = bm.parentId;
            });

            // 2. Sort Top 5
            const topFolders = Object.keys(folderScores)
                .sort((a, b) => folderScores[b] - folderScores[a])
                .slice(0, 5);

            // 3. Add Submenus
            topFolders.forEach(folderName => {
                const pId = folderIds[folderName];
                if (!pId) return;

                // Truncate name cleanly
                let label = folderName;
                if (label.length > 25) label = '...' + label.slice(-25);

                // Use a unique ID for the menu item
                chrome.contextMenus.create({
                    parentId: "sb_root",
                    id: "save_to_" + pId,
                    title: label,
                    contexts: ["page"]
                }, () => {
                    // Suppress errors for duplicate IDs if race condition
                    if (chrome.runtime.lastError) { }
                });
            });
        });
    });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId.startsWith("save_to_")) {
        const folderId = info.menuItemId.replace("save_to_", "");

        chrome.bookmarks.create({
            parentId: folderId,
            title: tab.title,
            url: tab.url
        }, (newBm) => {
            if (chrome.runtime.lastError) {
                console.error("Save failed:", chrome.runtime.lastError);
                return;
            }
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'Bookmark Saved!',
                message: 'Saved to ' + (newBm.parentId || 'Folder')
            });
            // Re-index trigger
            debouncedBuild();
        });
    }
});

function escapeXML(str) {
    if (!str) return '';
    return str.replace(/[<>&'"]/g, c => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

// OMNIBOX Listeners
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
    if (!indexedBookmarks.length) return;
    const query = text.trim().toLowerCase();
    const shortcutMatches = indexedBookmarks.filter(b => b.shortcut === query);
    if (shortcutMatches.length > 0) {
        suggest(shortcutMatches.map(b => ({
            content: b.url,
            description: `<match>${escapeXML(b.title)}</match> <dim>(${escapeXML(b.shortcut)})</dim>`
        })));
        return;
    }
    const terms = query.split(/\s+/).filter(t => t.length > 0);
    let matches = indexedBookmarks.filter(bookmark => {
        const title = (bookmark.title || '').toLowerCase();
        const folder = (bookmark.folderPath || '').toLowerCase();
        return terms.every(term => title.includes(term) || folder.includes(term));
    });
    const suggestions = matches.slice(0, 5).map(b => ({
        content: b.url,
        description: `${escapeXML(b.title)} <dim>- ${escapeXML(b.folderPath)}</dim>`
    }));
    suggest(suggestions);
});

chrome.omnibox.onInputEntered.addListener((text) => {
    if (text.startsWith('http')) {
        chrome.tabs.create({ url: text });
        return;
    }
    if (indexedBookmarks.length > 0) {
        const query = text.trim().toLowerCase();
        const shortcut = indexedBookmarks.find(b => b.shortcut === query);
        if (shortcut) { chrome.tabs.create({ url: shortcut.url }); return; }

        const matches = indexedBookmarks.filter(b => (b.title || '').toLowerCase().includes(query));
        if (matches.length > 0) chrome.tabs.create({ url: matches[0].url });
        else chrome.tabs.create({ url: "https://www.google.com/search?q=" + encodeURIComponent(text) });
    }
});
