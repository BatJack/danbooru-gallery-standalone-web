/**
 * Browser port of app/services/danbooru_service.py + app/services/site_adapters.py.
 * Talks to Danbooru/Gelbooru directly from the browser, falling back to a
 * user-configured CORS proxy when the direct request is blocked.
 */
(function () {
    const DG = (window.DG = window.DG || {});

    const DANBOORU_BASE = "https://danbooru.donmai.us";
    const GELBOORU_BASE = "https://gelbooru.com";
    const GELBOORU_APPROX_POSTS_PER_DAY = 12000;

    const CATEGORY_FIELDS = [
        ["artist", "tag_string_artist"],
        ["copyright", "tag_string_copyright"],
        ["character", "tag_string_character"],
        ["general", "tag_string_general"],
        ["meta", "tag_string_meta"],
    ];
    const ALLOWED_RATINGS = {
        general: "general", sensitive: "sensitive", questionable: "questionable", explicit: "explicit",
        g: "general", s: "sensitive", q: "questionable", e: "explicit",
    };

    function currentSettings() {
        return DG.settings ? DG.settings.load() : {};
    }

    function proxiedUrl(url, proxy) {
        const prefix = String(proxy || "").trim();
        if (!prefix) {
            return "";
        }
        if (prefix.includes("{url}")) {
            return prefix.replaceAll("{url}", encodeURIComponent(url));
        }
        return `${prefix.replace(/\/+$/, "")}/${encodeURIComponent(url)}`;
    }

    async function rawFetch(url, options = {}) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || 25000);
        try {
            return await fetch(url, {
                method: options.method || "GET",
                headers: options.headers,
                body: options.body,
                signal: controller.signal,
                redirect: "follow",
            });
        } finally {
            window.clearTimeout(timeout);
        }
    }

    async function request(url, options = {}) {
        try {
            return await rawFetch(url, options);
        } catch (error) {
            const proxy = currentSettings().cors_proxy;
            const fallback = proxiedUrl(url, proxy);
            if (!fallback) {
                throw error;
            }
            return rawFetch(fallback, options);
        }
    }

    async function requestJson(url, options = {}) {
        const response = await request(url, options);
        if (!response.ok) {
            throw new Error(await extractError(response));
        }
        return response.json();
    }

    async function requestText(url, options = {}) {
        const response = await request(url, options);
        if (!response.ok) {
            throw new Error(await extractError(response));
        }
        return response.text();
    }

    async function extractError(response) {
        try {
            const data = await response.json();
            return data.message || data.reason || `HTTP ${response.status}`;
        } catch (_error) {
            return `HTTP ${response.status}`;
        }
    }

    function normalizeAssetUrl(url, baseUrl = DANBOORU_BASE) {
        if (!url) {
            return null;
        }
        if (url.startsWith("//")) {
            return `https:${url}`;
        }
        if (url.startsWith("http")) {
            return url;
        }
        return new URL(url, baseUrl).toString();
    }

    function normalizeRatingValues(rating) {
        if (!rating || String(rating).toLowerCase() === "all") {
            return [];
        }
        const values = [];
        for (const rawValue of String(rating).split(",")) {
            const normalized = ALLOWED_RATINGS[rawValue.trim().toLowerCase()];
            if (normalized && !values.includes(normalized)) {
                values.push(normalized);
            }
        }
        return values;
    }

    function normalizeBeforeId(beforeId) {
        if (beforeId == null) {
            return "";
        }
        const value = String(beforeId).trim();
        return /^\d+$/.test(value) ? value : "";
    }

    function canUseBeforeId(tags) {
        return !String(tags || "").split(/\s+/).filter(Boolean)
            .some((token) => token.startsWith("order:") || token.startsWith("ordfav:") || token.startsWith("sort:"));
    }

    function selectPromptTags(post) {
        const settings = currentSettings();
        const selectedCategories = settings.selected_categories || ["copyright", "character", "general"];
        const blacklist = new Set(settings.blacklist || []);
        const filterTags = settings.filter_enabled === false ? new Set() : new Set(settings.filter_tags || []);
        const selected = [];
        for (const [categoryName, fieldName] of CATEGORY_FIELDS) {
            if (!selectedCategories.includes(categoryName)) {
                continue;
            }
            for (const tag of String(post[fieldName] || "").split(" ").filter(Boolean)) {
                if (blacklist.has(tag) || filterTags.has(tag)) {
                    continue;
                }
                selected.push(tag);
            }
        }
        return selected;
    }

    function formatPost(post, source) {
        const baseUrl = source === "gelbooru" ? GELBOORU_BASE : DANBOORU_BASE;
        const postId = post.id;
        const promptTags = selectPromptTags(post);
        const previewUrl = normalizeAssetUrl(post.preview_file_url || post.preview_url, baseUrl);
        const sampleUrl = normalizeAssetUrl(
            post.large_file_url || post.sample_file_url || post.sample_url || post.file_url,
            baseUrl,
        );
        const fileUrl = normalizeAssetUrl(post.file_url, baseUrl);
        return {
            id: postId,
            rating: post.rating,
            score: post.score || 0,
            fav_count: post.fav_count || 0,
            file_ext: post.file_ext,
            image_width: post.image_width,
            image_height: post.image_height,
            created_at: post.created_at,
            preview_url: previewUrl,
            sample_url: sampleUrl,
            file_url: fileUrl,
            post_url: source === "gelbooru"
                ? `${GELBOORU_BASE}/index.php?page=post&s=view&id=${postId}`
                : `${DANBOORU_BASE}/posts/${postId}`,
            tag_string: post.tag_string || "",
            tag_string_artist: post.tag_string_artist || "",
            tag_string_copyright: post.tag_string_copyright || "",
            tag_string_character: post.tag_string_character || "",
            tag_string_general: post.tag_string_general || "",
            tag_string_meta: post.tag_string_meta || "",
            gallery_prompt: promptTags.join(", "),
            source_site: source,
        };
    }

    // ---------- Danbooru ----------

    async function searchDanbooru({ tags, limit, page, rating, before_id }) {
        const searchTags = [];
        let dateTag = null;
        for (const rawTag of String(tags || "").split(/\s+/).filter(Boolean)) {
            if (rawTag.startsWith("date:")) {
                dateTag = rawTag;
            } else {
                searchTags.push(rawTag);
            }
        }
        if (dateTag) {
            searchTags.push(dateTag);
        }
        const ratingValues = normalizeRatingValues(rating);
        if (ratingValues.length === 1) {
            searchTags.push(`rating:${ratingValues[0]}`);
        } else if (ratingValues.length > 1) {
            for (const value of ratingValues) {
                searchTags.push(`~rating:${value}`);
            }
        }

        let cursor = normalizeBeforeId(before_id);
        if (cursor && !canUseBeforeId(tags)) {
            cursor = "";
        }
        const params = new URLSearchParams({
            tags: searchTags.join(" "),
            limit: String(limit),
            page: cursor ? `b${cursor}` : String(page),
        });
        const settings = currentSettings();
        if (settings.danbooru_username && settings.danbooru_api_key) {
            params.set("login", settings.danbooru_username);
            params.set("api_key", settings.danbooru_api_key);
        }
        const data = await requestJson(`${DANBOORU_BASE}/posts.json?${params.toString()}`);
        return (Array.isArray(data) ? data : []).map((post) => formatPost(post, "danbooru"));
    }

    async function autocompleteDanbooru(query, limit) {
        const params = new URLSearchParams({
            "search[name_or_alias_matches]": `${query}*`,
            "search[order]": "count",
            limit: String(limit),
        });
        const settings = currentSettings();
        if (settings.danbooru_username && settings.danbooru_api_key) {
            params.set("login", settings.danbooru_username);
            params.set("api_key", settings.danbooru_api_key);
        }
        const data = await requestJson(`${DANBOORU_BASE}/tags.json?${params.toString()}`);
        const results = [];
        for (const item of Array.isArray(data) ? data : []) {
            const name = item.name || "";
            results.push({
                name,
                category: item.category == null ? 0 : item.category,
                post_count: item.post_count || 0,
                translation: name ? await DG.translations.getChinese(name) : null,
                aliases: item.words || [],
            });
        }
        return results;
    }

    // ---------- Gelbooru ----------

    function gelbooruRatingQuery(rating) {
        const ratingMap = { g: "general", s: "sensitive", q: "questionable", e: "explicit" };
        let values = String(rating || "").split(",")
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean)
            .map((item) => ratingMap[item] || item);
        values = values.filter((value) => value && value !== "all");
        if (!values.length) {
            return "";
        }
        if (values.length === 1) {
            return `rating:${values[0]}`;
        }
        return values.map((value) => `~rating:${value}`).join(" ");
    }

    function gelbooruDapiPostsParams(tags, limit, page, rating) {
        const params = {
            page: "dapi",
            s: "post",
            q: "index",
            json: "1",
            tags: String(tags || "").trim(),
            limit: String(limit),
            pid: String(Math.max(page - 1, 0)),
        };
        const ratingQuery = gelbooruRatingQuery(rating);
        if (ratingQuery) {
            params.tags = `${params.tags} ${ratingQuery}`.trim();
        }
        return params;
    }

    function extractList(payload) {
        if (Array.isArray(payload)) {
            return payload;
        }
        if (payload && typeof payload === "object") {
            for (const key of ["post", "posts", "tag", "tags"]) {
                const value = payload[key];
                if (Array.isArray(value)) {
                    return value;
                }
                if (value && typeof value === "object") {
                    return [value];
                }
            }
        }
        return [];
    }

    function normalizeGelbooruPost(post) {
        const tags = String(post.tags || post.tag_string || "").trim();
        const fileUrl = post.file_url || "";
        const previewUrl = post.preview_url || post.preview_file_url || post.sample_url || fileUrl;
        const sampleUrl = post.sample_url || post.large_file_url || fileUrl;
        let fileExt = post.file_ext;
        if (!fileExt && fileUrl.includes(".")) {
            fileExt = fileUrl.split(".").pop().split("?")[0].toLowerCase();
        }
        const ratingMap = { safe: "general", general: "general", sensitive: "sensitive", questionable: "questionable", explicit: "explicit" };
        const rawRating = String(post.rating || "").toLowerCase();
        return {
            ...post,
            id: post.id,
            file_url: fileUrl,
            large_file_url: sampleUrl,
            preview_file_url: previewUrl,
            tag_string: tags,
            tag_string_artist: post.tag_string_artist || "",
            tag_string_copyright: post.tag_string_copyright || "",
            tag_string_character: post.tag_string_character || "",
            tag_string_general: post.tag_string_general || tags,
            tag_string_meta: post.tag_string_meta || "",
            image_width: Number(post.width || post.image_width) || 0,
            image_height: Number(post.height || post.image_height) || 0,
            created_at: post.created_at || post.created || "",
            file_ext: fileExt || "",
            rating: ratingMap[rawRating] || rawRating,
            source_site: "gelbooru",
        };
    }

    function gelbooruCreds() {
        const settings = currentSettings();
        return {
            user_id: String(settings.gelbooru_user_id || "").trim(),
            api_key: String(settings.gelbooru_api_key || "").trim(),
        };
    }

    function decodeHtml(value) {
        const textarea = document.createElement("textarea");
        textarea.innerHTML = value || "";
        return textarea.value;
    }

    function tagsFromTitle(value) {
        const cleaned = decodeHtml(value || "").replace(/\b(?:score|rating|size|user):[^\s]+/g, "");
        return cleaned.split(/\s+/).filter((tag) => tag && !tag.startsWith("-")).join(" ");
    }

    function ratingFromTags(tags) {
        const ratingMap = { safe: "general", general: "general", sensitive: "sensitive", questionable: "questionable", explicit: "explicit" };
        for (const tag of tags) {
            if (tag.startsWith("rating:")) {
                const value = tag.split(":")[1].toLowerCase();
                return ratingMap[value] || value;
            }
        }
        return "";
    }

    async function gelbooruLatestPostId() {
        const params = new URLSearchParams({
            page: "post", s: "list", tags: "", pid: "0",
        });
        const html = await requestText(`${GELBOORU_BASE}/index.php?${params.toString()}`);
        const doc = new DOMParser().parseFromString(html, "text/html");
        for (const anchor of doc.querySelectorAll('a[href*="page=post"]')) {
            const href = anchor.getAttribute("href") || "";
            if (!/s=view/.test(href)) {
                continue;
            }
            try {
                const id = new URL(href, GELBOORU_BASE).searchParams.get("id");
                if (id && /^\d+$/.test(id)) {
                    return parseInt(id, 10);
                }
            } catch (_error) {
                // ignore malformed href
            }
        }
        return 0;
    }

    async function applyGelbooruRecentFilter(tags) {
        const rawTags = String(tags || "");
        const match = rawTags.match(/(?:^|\s)recent:(\d+)d(?=\s|$)/i);
        if (!match) {
            return rawTags;
        }
        let cleaned = rawTags.replace(/(?:^|\s)recent:\d+d(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
        if (/(?:^|\s)id:[<>]?\d+(?=\s|$)/.test(cleaned)) {
            return cleaned;
        }
        const days = Math.max(1, Math.min(365, parseInt(match[1], 10)));
        const latestId = await gelbooruLatestPostId();
        if (!latestId) {
            return cleaned;
        }
        const threshold = Math.max(1, latestId - days * GELBOORU_APPROX_POSTS_PER_DAY);
        return `${cleaned} id:>${threshold}`.trim();
    }

    async function fetchGelbooruPublicPosts(tags, limit, page, rating) {
        const offsetStep = Math.max(1, limit);
        const params = new URLSearchParams({
            page: "post",
            s: "list",
            tags: `${String(tags || "").trim()} ${gelbooruRatingQuery(rating)}`.trim(),
            pid: String(Math.max(page - 1, 0) * offsetStep),
        });
        const html = await requestText(`${GELBOORU_BASE}/index.php?${params.toString()}`);
        const doc = new DOMParser().parseFromString(html, "text/html");
        const refs = [];
        const seen = new Set();
        for (const anchor of doc.querySelectorAll('a[href*="page=post"]')) {
            if (refs.length >= limit) {
                break;
            }
            const href = anchor.getAttribute("href") || "";
            if (!/s=view/.test(href)) {
                continue;
            }
            let postId;
            try {
                postId = new URL(href, GELBOORU_BASE).searchParams.get("id");
            } catch (_error) {
                continue;
            }
            if (!postId || seen.has(postId)) {
                continue;
            }
            const img = anchor.querySelector("img");
            const previewUrl = img
                ? normalizeAssetUrl(decodeHtml(img.getAttribute("data-src") || img.getAttribute("src") || ""), GELBOORU_BASE)
                : "";
            const title = img ? img.getAttribute("title") || img.getAttribute("alt") || "" : "";
            const tagString = tagsFromTitle(title);
            refs.push({
                id: postId,
                preview_file_url: previewUrl,
                large_file_url: previewUrl,
                file_url: previewUrl,
                tag_string: tagString,
                tag_string_artist: "",
                tag_string_copyright: "",
                tag_string_character: "",
                tag_string_general: tagString,
                tag_string_meta: "",
                image_width: 0,
                image_height: 0,
                rating: ratingFromTags(tagString.split(" ")),
                source_site: "gelbooru",
            });
            seen.add(postId);
        }

        const details = [];
        for (const ref of refs) {
            details.push(await fetchGelbooruPublicDetail(ref));
        }
        return details;
    }

    async function fetchGelbooruPublicDetail(ref) {
        try {
            const params = new URLSearchParams({ page: "post", s: "view", id: String(ref.id) });
            const html = await requestText(`${GELBOORU_BASE}/index.php?${params.toString()}`);
            const doc = new DOMParser().parseFromString(html, "text/html");
            const groups = { artist: [], copyright: [], character: [], general: [], meta: [] };
            const tagList = doc.querySelector("#tag-list");
            if (tagList) {
                for (const item of tagList.querySelectorAll("li")) {
                    const classes = item.getAttribute("class") || "";
                    const typeMatch = classes.match(/\btag-type-([a-z_-]+)\b/i);
                    let category = "general";
                    const rawType = (typeMatch ? typeMatch[1] : "general").toLowerCase();
                    if (rawType === "artist") category = "artist";
                    else if (rawType === "copyright") category = "copyright";
                    else if (rawType === "character") category = "character";
                    else if (rawType === "metadata" || rawType === "meta") category = "meta";
                    const hrefMatch = (item.querySelector('a[href*="tags="]') || {}).getAttribute
                        ? item.querySelector('a[href*="tags="]').getAttribute("href")
                        : "";
                    if (!hrefMatch) {
                        continue;
                    }
                    let tag = "";
                    try {
                        tag = new URL(hrefMatch, GELBOORU_BASE).searchParams.get("tags") || "";
                    } catch (_error) {
                        tag = "";
                    }
                    tag = decodeHtml(tag).trim();
                    if (tag && !tag.includes(" ") && !tag.startsWith("-") && !groups[category].includes(tag)) {
                        groups[category].push(tag);
                    }
                }
            }
            const allTags = [...groups.artist, ...groups.copyright, ...groups.character, ...groups.general, ...groups.meta];
            const tagString = allTags.join(" ") || ref.tag_string || "";

            const image = doc.querySelector("img#image");
            let fileUrl = "";
            if (image) {
                for (const attr of ["data-full-url", "data-original", "data-src", "src"]) {
                    const candidate = normalizeAssetUrl(decodeHtml(image.getAttribute(attr) || ""), GELBOORU_BASE);
                    if (candidate && !candidate.toLowerCase().includes("/thumbnail")) {
                        fileUrl = candidate;
                        break;
                    }
                }
            }
            fileUrl = fileUrl || ref.file_url || "";
            const width = image ? parseInt(image.getAttribute("width"), 10) || 0 : 0;
            const height = image ? parseInt(image.getAttribute("height"), 10) || 0 : 0;
            let fileExt = ref.file_ext || "";
            if (fileUrl.includes(".")) {
                fileExt = fileUrl.split(".").pop().split("?")[0].toLowerCase();
            }
            return {
                id: String(ref.id),
                file_url: fileUrl,
                large_file_url: fileUrl,
                preview_file_url: ref.preview_file_url || fileUrl,
                tag_string: tagString,
                tag_string_artist: groups.artist.join(" "),
                tag_string_copyright: groups.copyright.join(" "),
                tag_string_character: groups.character.join(" "),
                tag_string_general: groups.general.join(" ") || tagString,
                tag_string_meta: groups.meta.join(" "),
                image_width: width || ref.image_width || 0,
                image_height: height || ref.image_height || 0,
                file_ext: fileExt,
                rating: ratingFromTags(allTags) || ref.rating || "",
                created_at: ref.created_at || "",
                source_site: "gelbooru",
            };
        } catch (_error) {
            return ref;
        }
    }

    async function searchGelbooru({ tags, limit, page, rating }) {
        const filteredTags = await applyGelbooruRecentFilter(tags);
        const creds = gelbooruCreds();
        let posts;
        if (creds.user_id && creds.api_key) {
            const params = new URLSearchParams(gelbooruDapiPostsParams(filteredTags, limit, page, rating));
            params.set("user_id", creds.user_id);
            params.set("api_key", creds.api_key);
            const data = await requestJson(`${GELBOORU_BASE}/index.php?${params.toString()}`);
            posts = extractList(data).map(normalizeGelbooruPost);
        } else {
            posts = await fetchGelbooruPublicPosts(filteredTags, limit, page, rating);
        }
        return posts.map((post) => formatPost(post, "gelbooru"));
    }

    async function autocompleteGelbooru(query, limit) {
        const creds = gelbooruCreds();
        if (creds.user_id && creds.api_key) {
            const params = new URLSearchParams({
                page: "dapi", s: "tag", q: "index", json: "1",
                name_pattern: `${query}%`, orderby: "count", order: "DESC", limit: String(limit),
                user_id: creds.user_id, api_key: creds.api_key,
            });
            const data = await requestJson(`${GELBOORU_BASE}/index.php?${params.toString()}`);
            return normalizeGelbooruAutocomplete(extractList(data));
        }
        const params = new URLSearchParams({ page: "autocomplete2", type: "tag_query", term: query, limit: String(limit) });
        const data = await requestJson(`${GELBOORU_BASE}/index.php?${params.toString()}`);
        const results = [];
        for (const item of Array.isArray(data) ? data : []) {
            const name = item.value || item.label;
            if (!name) {
                continue;
            }
            results.push({
                name,
                category: item.category || "tag",
                post_count: parseInt(item.post_count, 10) || 0,
                translation: await DG.translations.getChinese(name),
                aliases: [],
            });
        }
        results.sort((left, right) => right.post_count - left.post_count);
        return results;
    }

    async function normalizeGelbooruAutocomplete(items) {
        const results = [];
        for (const item of items) {
            const name = item.name || item.tag;
            if (!name) {
                continue;
            }
            results.push({
                name,
                category: item.type || item.category || 0,
                post_count: parseInt(item.count || item.post_count, 10) || 0,
                translation: await DG.translations.getChinese(name),
                aliases: [],
            });
        }
        results.sort((left, right) => right.post_count - left.post_count);
        return results;
    }

    // ---------- Favorites ----------

    function requireDanbooruAuth() {
        const settings = currentSettings();
        const username = String(settings.danbooru_username || "").trim();
        const apiKey = String(settings.danbooru_api_key || "").trim();
        if (!username || !apiKey) {
            throw new Error("请先在设置中配置 Danbooru 用户名和 API Key");
        }
        return { username, apiKey };
    }

    function requireGelbooruAuth() {
        const creds = gelbooruCreds();
        if (!creds.user_id || !creds.api_key) {
            throw new Error("请先在设置中配置 Gelbooru User ID 和 API Key");
        }
        if (!/^\d+$/.test(creds.user_id)) {
            throw new Error("Gelbooru User ID 必须是数字 ID，不是用户名");
        }
        return creds;
    }

    async function syncDanbooruFavorites(pageLimit = 200, maxPages = 10) {
        const { username, apiKey } = requireDanbooruAuth();
        const favoriteIds = [];
        let truncated = false;
        for (let page = 1; page <= maxPages; page += 1) {
            const params = new URLSearchParams({
                tags: `ordfav:${username}`,
                limit: String(pageLimit),
                page: String(page),
                login: username,
                api_key: apiKey,
            });
            const response = await request(`${DANBOORU_BASE}/posts.json?${params.toString()}`);
            if (!response.ok) {
                throw new Error(await extractError(response));
            }
            const posts = await response.json();
            for (const post of posts || []) {
                if (post && post.id != null) {
                    favoriteIds.push(String(post.id));
                }
            }
            if (!posts || posts.length < pageLimit) {
                break;
            }
            if (page === maxPages) {
                truncated = true;
            }
        }
        return { success: true, source: "danbooru", username, favorites: favoriteIds, count: favoriteIds.length, truncated };
    }

    async function syncGelbooruFavorites(pageLimit = 100, maxPages = 10) {
        const creds = requireGelbooruAuth();
        const favoriteIds = [];
        let truncated = false;
        const size = Math.min(pageLimit, 100);
        for (let page = 1; page <= maxPages; page += 1) {
            const params = new URLSearchParams(gelbooruDapiPostsParams(`fav:${creds.user_id}`, size, page, null));
            params.set("user_id", creds.user_id);
            params.set("api_key", creds.api_key);
            const data = await requestJson(`${GELBOORU_BASE}/index.php?${params.toString()}`);
            const pageIds = extractList(data)
                .map((post) => (post && post.id != null ? String(post.id) : null))
                .filter(Boolean);
            favoriteIds.push(...pageIds);
            if (pageIds.length < size) {
                break;
            }
            if (page === maxPages) {
                truncated = true;
            }
        }
        return { success: true, source: "gelbooru", username: creds.user_id, favorites: favoriteIds, count: favoriteIds.length, truncated };
    }

    async function addFavorite(postId, source = "danbooru") {
        if (source === "gelbooru") {
            const creds = requireGelbooruAuth();
            const params = new URLSearchParams({ id: String(postId), user_id: creds.user_id, api_key: creds.api_key });
            const body = (await requestText(`${GELBOORU_BASE}/public/addfav.php?${params.toString()}`)).trim();
            if (body === "2") {
                throw new Error("Gelbooru 返回未登录；该站点可能不接受 API-only 收藏");
            }
            return { success: true, post_id: postId, message: body === "1" ? "已收藏，无需重复操作" : "收藏成功" };
        }
        const { username, apiKey } = requireDanbooruAuth();
        const params = new URLSearchParams({ login: username, api_key: apiKey });
        const response = await request(`${DANBOORU_BASE}/favorites.json?${params.toString()}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ post_id: String(postId) }).toString(),
        });
        if (response.status === 200 || response.status === 201) {
            return { success: true, post_id: postId, message: "收藏成功" };
        }
        const message = await extractError(response);
        if (response.status === 422 && message.toLowerCase().includes("already favorited")) {
            return { success: true, post_id: postId, message: "已收藏，无需重复操作" };
        }
        throw new Error(message);
    }

    async function removeFavorite(postId, source = "danbooru") {
        if (source === "gelbooru") {
            const creds = requireGelbooruAuth();
            const params = new URLSearchParams({
                page: "favorites", s: "delete", id: String(postId),
                user_id: creds.user_id, api_key: creds.api_key,
            });
            const response = await request(`${GELBOORU_BASE}/index.php?${params.toString()}`);
            if ([200, 302, 303, 404].includes(response.status)) {
                return { success: true, post_id: postId, message: "取消收藏成功" };
            }
            throw new Error(await extractError(response));
        }
        const { username, apiKey } = requireDanbooruAuth();
        const params = new URLSearchParams({ login: username, api_key: apiKey });
        const response = await request(`${DANBOORU_BASE}/favorites/${postId}.json?${params.toString()}`, { method: "DELETE" });
        if ([200, 204, 404].includes(response.status)) {
            return { success: true, post_id: postId, message: "取消收藏成功" };
        }
        throw new Error(await extractError(response));
    }

    DG.gallery = {
        searchPosts: async ({ tags, limit = 20, page = 1, rating = "all", before_id = "", source = "danbooru" }) => {
            const normalizedSource = source === "gelbooru" ? "gelbooru" : "danbooru";
            if (normalizedSource === "gelbooru") {
                return searchGelbooru({ tags, limit, page, rating });
            }
            return searchDanbooru({ tags, limit, page, rating, before_id });
        },
        autocomplete: async (query, limit = 20, source = "danbooru") => {
            if (!query) {
                return [];
            }
            if (source === "gelbooru") {
                return autocompleteGelbooru(query, limit);
            }
            return autocompleteDanbooru(query, limit);
        },
        authStatus: () => {
            const settings = currentSettings();
            return {
                has_auth: Boolean(String(settings.danbooru_username || "").trim() && String(settings.danbooru_api_key || "").trim()),
                username: settings.danbooru_username || "",
                gelbooru_has_auth: Boolean(String(settings.gelbooru_user_id || "").trim() && String(settings.gelbooru_api_key || "").trim()),
                gelbooru_user_id: settings.gelbooru_user_id || "",
            };
        },
        syncFavorites: (source = "danbooru") => (source === "gelbooru" ? syncGelbooruFavorites() : syncDanbooruFavorites()),
        addFavorite,
        removeFavorite,
        imageUrl: (url) => {
            if (!url) {
                return url;
            }
            const proxy = currentSettings().image_proxy;
            return proxy ? proxiedUrl(url, proxy) || url : url;
        },
    };
})();
