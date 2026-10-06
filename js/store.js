/**
 * Browser-side replacement for the FastAPI backend:
 *  - settings persisted in localStorage (app/services/settings_service.py)
 *  - prompt library persisted in localStorage (app/services/prompt_library_service.py)
 *  - a virtual /api router that answers the same requests the frontend already makes
 *    (app/main.py)
 */
(function () {
    const DG = (window.DG = window.DG || {});

    const SETTINGS_KEY = "danbooru-pages.settings";
    const LIBRARY_KEY = "danbooru-pages.library";
    const DEFAULT_LIBRARY_URL = "assets/default_prompt_library.json";

    const DEFAULT_SETTINGS = {
        language: "zh",
        blacklist: [],
        filter_tags: [
            "watermark",
            "sample_watermark",
            "weibo_username",
            "weibo",
            "weibo_logo",
            "weibo_watermark",
            "censored",
            "mosaic_censoring",
            "artist_name",
            "twitter_username",
        ],
        filter_enabled: true,
        selected_categories: ["copyright", "character", "general"],
        danbooru_username: "",
        danbooru_api_key: "",
        gelbooru_user_id: "",
        gelbooru_api_key: "",
        source_site: "danbooru",
        default_source_site: "danbooru",
        gelbooru_display_all_site_content: false,
        autocomplete_max_results: 20,
        high_quality_previews: true,
        cors_proxy: "",
        image_proxy: "",
    };

    // localStorage can be unavailable (private mode / file://). Fall back to memory.
    const memory = new Map();
    const storage = {
        getItem(key) {
            try {
                return window.localStorage.getItem(key);
            } catch (_error) {
                return memory.has(key) ? memory.get(key) : null;
            }
        },
        setItem(key, value) {
            try {
                window.localStorage.setItem(key, value);
            } catch (_error) {
                memory.set(key, value);
            }
        },
    };

    function utcNow() {
        return new Date().toISOString();
    }

    function uuid() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return window.crypto.randomUUID();
        }
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
            const rand = (Math.random() * 16) | 0;
            const value = char === "x" ? rand : (rand & 0x3) | 0x8;
            return value.toString(16);
        });
    }

    // ---------- settings ----------

    function loadSettings() {
        const data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        const raw = storage.getItem(SETTINGS_KEY);
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                for (const [key, value] of Object.entries(parsed)) {
                    if (key in data && value !== null) {
                        data[key] = value;
                    }
                }
            } catch (_error) {
                // keep defaults on corrupt data
            }
        }
        return data;
    }

    function saveSettings(patch) {
        const data = loadSettings();
        for (const [key, value] of Object.entries(patch || {})) {
            if (value !== null && value !== undefined && key in data) {
                data[key] = value;
            }
        }
        storage.setItem(SETTINGS_KEY, JSON.stringify(data));
        return data;
    }

    // ---------- prompt library ----------

    function ensureCompatibility(input) {
        const data = input && typeof input === "object" ? input : {};
        if (!data.version) {
            data.version = "1.6";
        }
        if (!data.settings) {
            data.settings = { language: "zh-CN", separator: ", ", save_selection: true };
        }
        if (!Array.isArray(data.categories)) {
            data.categories = [];
        }
        if (!data.last_modified) {
            data.last_modified = utcNow();
        }
        for (const category of data.categories) {
            if (!category.updated_at) {
                category.updated_at = utcNow();
            }
            if (!Array.isArray(category.prompts)) {
                category.prompts = [];
            }
            for (const prompt of category.prompts) {
                if (!prompt.id) prompt.id = uuid();
                if (prompt.description == null) prompt.description = "";
                if (!Array.isArray(prompt.tags)) prompt.tags = [];
                if (prompt.image == null) prompt.image = "";
                if (prompt.favorite == null) prompt.favorite = false;
                if (prompt.template == null) prompt.template = false;
                if (!prompt.created_at) prompt.created_at = utcNow();
                if (!prompt.updated_at) prompt.updated_at = prompt.created_at;
                if (prompt.usage_count == null) prompt.usage_count = 0;
                if (prompt.last_used === undefined) prompt.last_used = null;
            }
        }
        return data;
    }

    let libraryCache = null;
    let libraryLoadPromise = null;

    async function loadLibrary() {
        if (libraryCache) {
            return libraryCache;
        }
        const raw = storage.getItem(LIBRARY_KEY);
        if (raw) {
            try {
                libraryCache = ensureCompatibility(JSON.parse(raw));
                return libraryCache;
            } catch (_error) {
                // fall through to bundled default
            }
        }
        if (!libraryLoadPromise) {
            libraryLoadPromise = (async () => {
                let data = {};
                try {
                    const response = await fetch(DEFAULT_LIBRARY_URL);
                    if (response.ok) {
                        data = await response.json();
                    }
                } catch (_error) {
                    data = {};
                }
                libraryCache = ensureCompatibility(data);
                persistLibrary();
                return libraryCache;
            })();
        }
        return libraryLoadPromise;
    }

    function persistLibrary() {
        libraryCache.last_modified = utcNow();
        storage.setItem(LIBRARY_KEY, JSON.stringify(libraryCache));
        return libraryCache;
    }

    function saveLibrary(data) {
        libraryCache = ensureCompatibility(data);
        return persistLibrary();
    }

    function getCategory(data, name) {
        const category = data.categories.find((item) => item.name === name);
        if (!category) {
            throw new Error(`分类不存在: ${name}`);
        }
        return category;
    }

    function createCategory(name) {
        const data = libraryCache;
        if (data.categories.some((category) => category.name === name)) {
            throw new Error("分类已存在");
        }
        data.categories.push({ name, updated_at: utcNow(), prompts: [] });
        return persistLibrary();
    }

    function renameCategory(oldName, newName) {
        const data = libraryCache;
        const category = getCategory(data, oldName);
        if (data.categories.some((item) => item.name === newName && item.name !== oldName)) {
            throw new Error("新分类名已存在");
        }
        category.name = newName;
        category.updated_at = utcNow();
        return persistLibrary();
    }

    function deleteCategory(name) {
        const data = libraryCache;
        data.categories = data.categories.filter((category) => category.name !== name);
        return persistLibrary();
    }

    function addPrompt(payload) {
        const data = libraryCache;
        const category = getCategory(data, payload.category);
        const now = utcNow();
        category.prompts.push({
            id: uuid(),
            alias: payload.alias || "",
            prompt: payload.prompt || "",
            description: payload.description || "",
            tags: payload.tags || [],
            image: payload.image || "",
            favorite: payload.favorite || false,
            template: payload.template || false,
            created_at: now,
            updated_at: now,
            usage_count: 0,
            last_used: null,
        });
        category.updated_at = now;
        return persistLibrary();
    }

    function updatePrompt(promptId, payload) {
        const data = libraryCache;
        const now = utcNow();
        let promptToMove = null;
        let sourceCategory = null;
        for (const category of data.categories) {
            const found = category.prompts.find((prompt) => prompt.id === promptId);
            if (found) {
                promptToMove = found;
                sourceCategory = category;
                break;
            }
        }
        if (!promptToMove || !sourceCategory) {
            throw new Error("提示词不存在");
        }

        for (const field of ["alias", "prompt", "description", "tags", "image", "favorite", "template"]) {
            if (field in (payload || {}) && payload[field] != null) {
                promptToMove[field] = payload[field];
            }
        }
        promptToMove.updated_at = now;
        sourceCategory.updated_at = now;

        const targetName = payload ? payload.category : null;
        if (targetName && targetName !== sourceCategory.name) {
            const targetCategory = getCategory(data, targetName);
            sourceCategory.prompts = sourceCategory.prompts.filter((item) => item.id !== promptId);
            targetCategory.prompts.push(promptToMove);
            targetCategory.updated_at = now;
        }
        return persistLibrary();
    }

    function deletePrompt(promptId) {
        const data = libraryCache;
        const now = utcNow();
        for (const category of data.categories) {
            const before = category.prompts.length;
            category.prompts = category.prompts.filter((prompt) => prompt.id !== promptId);
            if (category.prompts.length !== before) {
                category.updated_at = now;
                return persistLibrary();
            }
        }
        throw new Error("提示词不存在");
    }

    function toggleFavorite(promptId) {
        const data = libraryCache;
        const now = utcNow();
        for (const category of data.categories) {
            const prompt = category.prompts.find((item) => item.id === promptId);
            if (prompt) {
                prompt.favorite = !prompt.favorite;
                prompt.updated_at = now;
                category.updated_at = now;
                return persistLibrary();
            }
        }
        throw new Error("提示词不存在");
    }

    function libraryMetadata() {
        const data = libraryCache;
        return {
            last_modified: data.last_modified,
            version: data.version,
            categories_count: data.categories.length,
            total_prompts: data.categories.reduce((sum, category) => sum + category.prompts.length, 0),
        };
    }

    DG.settings = { load: loadSettings, save: saveSettings, defaults: DEFAULT_SETTINGS };
    DG.library = {
        load: async () => {
            await loadLibrary();
            return libraryCache;
        },
        save: saveLibrary,
        createCategory,
        renameCategory,
        deleteCategory,
        addPrompt,
        updatePrompt,
        deletePrompt,
        toggleFavorite,
        metadata: libraryMetadata,
    };

    // ---------- virtual /api router ----------

    function parseBody(options) {
        const raw = options && options.body;
        if (!raw) {
            return {};
        }
        if (typeof raw === "string") {
            try {
                return JSON.parse(raw);
            } catch (_error) {
                return {};
            }
        }
        return {};
    }

    function isApiPath(path) {
        return typeof path === "string" && path.split("?")[0].startsWith("/api/");
    }

    async function handle(path, options = {}) {
        const url = new URL(path, window.location.href);
        const route = url.pathname.replace(/\/+$/, "") || "/";
        const method = (options.method || "GET").toUpperCase();
        const params = url.searchParams;
        const body = parseBody(options);

        if (route === "/api/health") {
            return { ok: true };
        }

        if (route === "/api/app/shutdown") {
            return { ok: true, message: "静态站点无需退出后端。" };
        }

        if (route === "/api/settings") {
            return method === "POST" ? saveSettings(body) : loadSettings();
        }

        if (route === "/api/danbooru/posts") {
            return DG.gallery.searchPosts({
                tags: params.get("tags") || "",
                limit: Math.min(parseInt(params.get("limit"), 10) || 20, 100),
                page: parseInt(params.get("page"), 10) || 1,
                rating: params.get("rating") || "all",
                before_id: params.get("before_id") || "",
                source: params.get("source") || "danbooru",
            });
        }

        if (route === "/api/danbooru/auth") {
            return DG.gallery.authStatus();
        }

        if (route === "/api/danbooru/favorites/sync") {
            return DG.gallery.syncFavorites(params.get("source") || "danbooru");
        }

        if (route === "/api/danbooru/favorites/add") {
            return DG.gallery.addFavorite(body.post_id, body.source || "danbooru");
        }

        if (route === "/api/danbooru/favorites/remove") {
            return DG.gallery.removeFavorite(body.post_id, body.source || "danbooru");
        }

        if (route === "/api/danbooru/image") {
            return params.get("url") || "";
        }

        if (route === "/api/tags/autocomplete") {
            return DG.gallery.autocomplete(
                params.get("query") || "",
                parseInt(params.get("limit"), 10) || 20,
                params.get("source") || "danbooru",
            );
        }

        if (route === "/api/tags/search-chinese") {
            const query = params.get("query") || "";
            const results = await DG.translations.searchChinese(query, parseInt(params.get("limit"), 10) || 10);
            return { query, results };
        }

        if (route === "/api/tags/translate-batch") {
            return { translations: await DG.translations.translateBatch(body.tags || []) };
        }

        if (route === "/api/prompts/clean") {
            const prompt = body.prompt || "";
            const { prompt: _ignored, ...cleanOptions } = body;
            return { prompt: DG.promptClean.clean(prompt, cleanOptions) };
        }

        if (route === "/api/library") {
            const data = await DG.library.load();
            return method === "PUT" ? DG.library.save(body) : data;
        }

        if (route === "/api/library/metadata") {
            await DG.library.load();
            return DG.library.metadata();
        }

        if (route === "/api/library/categories") {
            await DG.library.load();
            if (method === "POST") {
                return DG.library.createCategory(body.name);
            }
            if (method === "PATCH") {
                return DG.library.renameCategory(body.old_name, body.new_name);
            }
            if (method === "DELETE") {
                return DG.library.deleteCategory(params.get("name") || "");
            }
        }

        if (route === "/api/library/prompts" && method === "POST") {
            await DG.library.load();
            return DG.library.addPrompt(body);
        }

        const promptMatch = route.match(/^\/api\/library\/prompts\/([^/]+)(\/toggle-favorite)?$/);
        if (promptMatch) {
            await DG.library.load();
            const promptId = decodeURIComponent(promptMatch[1]);
            if (promptMatch[2]) {
                return DG.library.toggleFavorite(promptId);
            }
            if (method === "PATCH") {
                return DG.library.updatePrompt(promptId, body);
            }
            if (method === "DELETE") {
                return DG.library.deletePrompt(promptId);
            }
        }

        if (route === "/api/library/upload-image") {
            throw new Error("静态站点不支持服务端图片上传，请使用图片直链。");
        }

        throw new Error(`静态站点未实现的接口: ${method} ${route}`);
    }

    DG.api = { canHandle: isApiPath, handle };
})();
