function setRankingEnabled(enabled) {
    const tokens = tokenizeCommaInput(elements.searchTags.value);
    const rankingTokens = new Set(getAllRankingTokens());
    const filtered = tokens.filter((token) => !rankingTokens.has(token));
    if (enabled) {
        filtered.push(getRankingToken());
    }
    elements.searchTags.value = buildSearchInputFromTokens(filtered);
}

function toggleRankingToken() {
    const isRankingEnabled = tokenizeCommaInput(elements.searchTags.value).includes(getRankingToken());
    if (!isRankingEnabled && state.favoritesOnly) {
        state.favoritesOnly = false;
    }
    setRankingEnabled(!isRankingEnabled);
    updateSearchControlsState();
    saveUiPrefs();
    runSearch({ resetPage: true, forceReload: true });
}

async function toggleFavoritesMode() {
    state.favoritesOnly = !state.favoritesOnly;
    if (state.favoritesOnly) {
        setRankingEnabled(false);
    }
    if (state.favoritesOnly && hasRemoteFavoriteAuth()) {
        await syncRemoteFavorites({ silent: true });
    }
    updateSearchControlsState();
    saveUiPrefs();
    await runSearch({ resetPage: true, forceReload: true });
}

async function switchSource() {
    const previousSource = currentSource();
    const nextSource = currentSource() === "danbooru" ? "gelbooru" : "danbooru";
    const hadRanking = tokenizeCommaInput(elements.searchTags.value).includes(getRankingToken(previousSource));
    state.settings = { ...(state.settings || {}), source_site: nextSource };
    setRankingEnabled(false);
    if (hadRanking || !elements.searchTags.value.trim()) {
        setRankingEnabled(true);
    }
    state.favoritesOnly = false;
    state.onlineSearchCache = createEmptyOnlineSearchCache();
    state.currentPosts = [];
    state.searchResults = [];
    state.originalPosts = {};
    state.postEdits = {};
    state.editingPostId = null;
    state.viewingPostId = null;
    elements.searchStatus.textContent = `正在切换到 ${currentSourceLabel()}...`;
    updateSearchControlsState();
    renderResults();
    saveUiPrefs();
    try {
        state.settings = await api("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_site: nextSource }),
        });
        syncSettingsForm();
    } catch (error) {
        notify(`保存当前站点失败: ${error.message}`, "error");
    }
    await syncRemoteFavorites({ silent: true });
    await runSearch({ resetPage: true, forceReload: true });
}

async function applyStartupSourcePreference() {
    const startupSource = normalizeSourceKey(state.settings?.default_source_site);
    if (currentSource() === startupSource) {
        return;
    }
    state.settings = { ...(state.settings || {}), source_site: startupSource };
    try {
        state.settings = await api("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_site: startupSource }),
        });
    } catch (error) {
        notify(`应用启动默认站点失败: ${error.message}`, "error");
    }
}

function jumpToTypedPage() {
    goToPage(elements.searchPage.value);
}

function enablePageCloseWithoutPrompt() {
    state.appExit.ignoreBeforeUnloadPrompt = true;
}

function handleBeforeUnload(event) {
    if (state.appExit.ignoreBeforeUnloadPrompt || state.appExit.shutdownInFlight) {
        return undefined;
    }
    event.preventDefault();
    event.returnValue = "";
    return "";
}

function openExitDialog() {
    openDialog(elements.exitDialog);
}

function closeExitDialog() {
    elements.exitDialog.close();
}

function closePageOnly() {
    enablePageCloseWithoutPrompt();
    closeExitDialog();
    window.close();
    window.setTimeout(() => {
        if (!window.closed) {
            notify("浏览器没有允许脚本直接关页，请手动关闭当前标签页。");
        }
    }, 250);
}

async function exitApplication() {
    if (state.appExit.shutdownInFlight) {
        return;
    }

    state.appExit.shutdownInFlight = true;
    elements.confirmExitAppBtn.disabled = true;
    elements.confirmExitAppBtn.textContent = "正在退出...";

    try {
        await api("/api/app/shutdown", { method: "POST" });
        enablePageCloseWithoutPrompt();
        closeExitDialog();
        elements.searchStatus.textContent = "应用正在退出...";
        notify("应用正在退出，本页可以直接关闭。", "success");
        window.setTimeout(() => {
            window.close();
        }, 400);
    } catch (error) {
        state.appExit.shutdownInFlight = false;
        elements.confirmExitAppBtn.disabled = false;
        elements.confirmExitAppBtn.textContent = "退出应用";
        notify(`退出应用失败: ${error.message}`, "error");
    }
}

function bindEvents() {
    bindDropdowns();
    attachAutocomplete(elements.searchTags, elements.searchAutocomplete, "search");
    attachAutocomplete(elements.addTagInput, elements.addTagAutocomplete, "replace");
    window.addEventListener("beforeunload", handleBeforeUnload);

    elements.searchTags.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            runSearch({ resetPage: true });
        }
    });
    elements.searchTags.addEventListener("input", () => {
        updateSearchControlsState();
        saveUiPrefs();
    });
    elements.clearSearchBtn.addEventListener("click", () => {
        elements.searchTags.value = "";
        updateSearchControlsState();
        saveUiPrefs();
        runSearch({ resetPage: true });
    });
    elements.ratingAllCheckbox.addEventListener("change", () => {
        const checked = elements.ratingAllCheckbox.checked;
        elements.ratingValueCheckboxes.forEach((checkbox) => {
            checkbox.checked = checked;
        });
        updateRatingButtonLabel();
        saveUiPrefs();
        runSearch({ resetPage: true });
    });
    elements.ratingValueCheckboxes.forEach((checkbox) => {
        checkbox.addEventListener("change", () => {
            elements.ratingAllCheckbox.checked = getSelectedRatingValues().length === RATING_VALUES.length;
            updateRatingButtonLabel();
            saveUiPrefs();
            runSearch({ resetPage: true });
        });
    });
    elements.searchLimit.addEventListener("change", () => {
        saveUiPrefs();
        runSearch({ resetPage: true });
    });
    elements.gelbooruRecency.addEventListener("change", () => {
        saveUiPrefs();
        runSearch({ resetPage: true, forceReload: true });
    });
    elements.searchPage.addEventListener("change", () => {
        jumpToTypedPage();
    });
    elements.searchPage.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            jumpToTypedPage();
        }
    });
    elements.prevPageBtn.addEventListener("click", () => {
        goToPage((Number(elements.searchPage.value) || 1) - 1);
    });
    elements.jumpPageBtn.addEventListener("click", jumpToTypedPage);
    elements.nextPageBtn.addEventListener("click", () => {
        goToPage((Number(elements.searchPage.value) || 1) + 1);
    });

    elements.sourceToggle.addEventListener("click", switchSource);
    elements.rankingToggle.addEventListener("click", toggleRankingToken);
    elements.favoritesToggle.addEventListener("click", toggleFavoritesMode);
    elements.favoritesCountBtn.addEventListener("click", toggleFavoritesMode);
    elements.openExitDialogBtn.addEventListener("click", openExitDialog);
    elements.refreshBtn.addEventListener("click", () => runSearch({ forceReload: true }));
    elements.filterToggle.addEventListener("click", toggleFilterSetting);
    elements.openSettingsBtn.addEventListener("click", () => openDialog(elements.settingsDialog));
    elements.closeSettingsBtn.addEventListener("click", () => elements.settingsDialog.close());
    elements.cancelSettingsBtn.addEventListener("click", () => elements.settingsDialog.close());
    elements.settingsForm.addEventListener("submit", saveSettings);
    elements.toolbarCategoryCheckboxes.forEach((checkbox) => {
        checkbox.addEventListener("change", persistSelectedCategories);
    });
    elements.fmtReplaceUnderscores.addEventListener("change", () => {
        saveUiPrefs();
        rerenderAllPrompts();
    });
    elements.fmtEscapeBrackets.addEventListener("change", () => {
        saveUiPrefs();
        rerenderAllPrompts();
    });

    elements.closeEditorBtn.addEventListener("click", closeEditor);
    elements.editorDialog.addEventListener("close", () => {
        cleanupEditIfUnchanged(state.editingPostId);
        updateSelectionStatus();
        renderResults();
    });
    elements.closeViewerBtn.addEventListener("click", closeViewer);
    elements.viewerDialog.addEventListener("click", (event) => {
        if (event.target === elements.viewerDialog) {
            closeViewer();
        }
    });
    elements.viewerDialog.addEventListener("close", () => {
        state.viewingPostId = null;
    });
    elements.viewerOpenPostBtn.addEventListener("click", () => {
        const url = elements.viewerOpenPostBtn.dataset.postUrl;
        if (url) {
            window.open(url, "_blank", "noopener,noreferrer");
        }
    });
    elements.viewerEditBtn.addEventListener("click", async () => {
        const postId = state.viewingPostId;
        closeViewer();
        if (postId) {
            await openEditor(postId);
        }
    });
    elements.closeExitDialogBtn.addEventListener("click", closeExitDialog);
    elements.cancelExitBtn.addEventListener("click", closeExitDialog);
    elements.closePageBtn.addEventListener("click", closePageOnly);
    elements.confirmExitAppBtn.addEventListener("click", exitApplication);
    elements.addTagBtn.addEventListener("click", addTagToEditor);
    elements.addTagInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addTagToEditor();
        }
    });
    elements.cleanPromptBtn.addEventListener("click", cleanPrompt);
    elements.copyPromptBtn.addEventListener("click", copyPrompt);
    elements.resetTagsBtn.addEventListener("click", resetEditorTags);
    elements.promptEditor.addEventListener("input", resizePromptEditor);
    window.addEventListener("resize", resizePromptEditor);

    elements.openLibraryBtn.addEventListener("click", async () => {
        await loadLibrary();
        openDialog(elements.libraryDialog);
    });
    elements.closeLibraryBtn.addEventListener("click", () => elements.libraryDialog.close());
    elements.newCategoryBtn.addEventListener("click", createCategory);
    elements.renameCategoryBtn.addEventListener("click", renameCategory);
    elements.deleteCategoryBtn.addEventListener("click", deleteCategory);
    elements.newPromptBtn.addEventListener("click", () => {
        if (!state.library?.categories?.length) {
            notify("先创建一个分类，再新建词条。");
            return;
        }
        openPromptDialog();
    });
    elements.exportLibraryBtn.addEventListener("click", exportLibrary);
    elements.importLibraryBtn.addEventListener("click", () => elements.importFileInput.click());
    elements.importFileInput.addEventListener("change", importLibrary);

    elements.promptForm.addEventListener("submit", savePromptEntry);
    elements.closePromptDialogBtn.addEventListener("click", closePromptDialog);
    elements.cancelPromptDialogBtn.addEventListener("click", closePromptDialog);
}

async function init() {
    state.uiPrefs = {
        ...DEFAULT_UI_PREFS,
        replaceUnderscores: state.uiPrefs.replaceUnderscores,
        escapeBrackets: state.uiPrefs.escapeBrackets,
        limit: state.uiPrefs.limit || DEFAULT_UI_PREFS.limit,
        gelbooruRecentDays: state.uiPrefs.gelbooruRecentDays || DEFAULT_UI_PREFS.gelbooruRecentDays,
    };
    syncUiPrefsToControls();
    updateFavoritesCount();
    updateSearchControlsState();
    bindEvents();
    await loadSettings();
    await applyStartupSourcePreference();
    await syncRemoteFavorites({ silent: true });
    await loadLibrary();
    elements.searchTags.value = getRankingToken();
    if (currentSource() === "gelbooru" && elements.gelbooruRecency.value === "all") {
        elements.gelbooruRecency.value = DEFAULT_UI_PREFS.gelbooruRecentDays;
    }
    applySelectedRatingValues([...RATING_VALUES]);
    elements.searchPage.value = "1";
    saveUiPrefs();
    updateSearchControlsState();
    await runSearch({ resetPage: true });
}

init().catch((error) => {
    notify(`初始化失败: ${error.message}`, "error");
});
