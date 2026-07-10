from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Iterable
from urllib.parse import urljoin

import requests
from requests.auth import HTTPBasicAuth

from ..paths import BUNDLED_ZH_CN_DIR
from ..shared.db.db_manager import TagDatabaseManager
from ..shared.translation.translation_loader import TranslationLoader
from ..utils.logger import get_logger
from .settings_service import SettingsService
from .site_adapters import get_site_adapter


logger = get_logger(__name__)

BASE_URL = "https://danbooru.donmai.us"
GELBOORU_BASE_URL = "https://gelbooru.com"
DANBOORU_HEADERS = {
    "User-Agent": "Danbooru-Gallery/1.0",
}
GELBOORU_BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Accept": "text/html,*/*",
    "Referer": "https://gelbooru.com/",
}
GELBOORU_JSON_HEADERS = {
    **GELBOORU_BROWSER_HEADERS,
    "Accept": "application/json,text/javascript,*/*;q=0.01",
}

CATEGORY_FIELDS = [
    ("artist", "tag_string_artist"),
    ("copyright", "tag_string_copyright"),
    ("character", "tag_string_character"),
    ("general", "tag_string_general"),
    ("meta", "tag_string_meta"),
]

ALLOWED_RATINGS = {
    "general": "general",
    "sensitive": "sensitive",
    "questionable": "questionable",
    "explicit": "explicit",
    "g": "general",
    "s": "sensitive",
    "q": "questionable",
    "e": "explicit",
}


class _RateLimiter:
    def __init__(self, min_interval_sec: float):
        self.min_interval = min_interval_sec
        self._last_ts = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_ts
            if elapsed < self.min_interval:
                time.sleep(self.min_interval - elapsed)
            self._last_ts = time.monotonic()


_donmai_throttle = _RateLimiter(min_interval_sec=0.2)
_gelbooru_api_throttle = _RateLimiter(min_interval_sec=0.1)
_gelbooru_throttle = _RateLimiter(min_interval_sec=0.75)
_gelbooru_detail_throttle = _RateLimiter(min_interval_sec=0.2)
GELBOORU_APPROX_POSTS_PER_DAY = 12000
GELBOORU_LATEST_ID_CACHE_SECONDS = 600


def danbooru_request(method: str, url: str, **kwargs) -> requests.Response:
    headers = dict(kwargs.pop("headers", None) or {})
    for key, value in DANBOORU_HEADERS.items():
        headers.setdefault(key, value)

    response = None
    for attempt in range(2):
        _donmai_throttle.wait()
        response = requests.request(method, url, headers=headers, **kwargs)
        if response.status_code not in {429, 503} or attempt == 1:
            return response

        retry_after = response.headers.get("Retry-After")
        delay = 2.0
        try:
            if retry_after is not None:
                delay = min(max(float(retry_after), 0.5), 10.0)
        except ValueError:
            pass
        logger.warning(f"[Danbooru] {response.status_code} 限流，{delay:.1f}s 后重试: {url}")
        time.sleep(delay)

    return response


def gelbooru_api_request(method: str, url: str, **kwargs) -> requests.Response:
    headers = dict(kwargs.pop("headers", None) or {})
    for key, value in GELBOORU_JSON_HEADERS.items():
        headers.setdefault(key, value)

    response = None
    for attempt in range(2):
        _gelbooru_api_throttle.wait()
        response = requests.request(method, url, headers=headers, **kwargs)
        if response.status_code not in {429, 503} or attempt == 1:
            return response

        retry_after = response.headers.get("Retry-After")
        delay = 1.0
        try:
            if retry_after is not None:
                delay = min(max(float(retry_after), 0.5), 8.0)
        except ValueError:
            pass
        logger.warning(f"[Gelbooru] {response.status_code} 限流，{delay:.1f}s 后重试: {url}")
        time.sleep(delay)

    return response


class DanbooruFavoriteError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class DanbooruService:
    def __init__(self, db_manager: TagDatabaseManager, settings_service: SettingsService):
        self.db_manager = db_manager
        self.settings_service = settings_service
        self.translation_loader = TranslationLoader(str(BUNDLED_ZH_CN_DIR))
        self.translation_loader.load_all()
        self._gelbooru_latest_id_cache: tuple[int, float] | None = None

    def _credentials(self) -> tuple[str, str]:
        settings = self.settings_service.load()
        username = settings.get("danbooru_username", "")
        api_key = settings.get("danbooru_api_key", "")
        return username, api_key

    def _gelbooru_credentials(self) -> tuple[str, str]:
        settings = self.settings_service.load()
        user_id = settings.get("gelbooru_user_id", "")
        api_key = settings.get("gelbooru_api_key", "")
        return user_id, api_key

    def _auth(self):
        username, api_key = self._credentials()
        if username and api_key:
            return HTTPBasicAuth(username, api_key)
        return None

    def auth_status(self) -> dict[str, str | bool]:
        username, api_key = self._credentials()
        gelbooru_user_id, gelbooru_api_key = self._gelbooru_credentials()
        return {
            "has_auth": bool(username and api_key),
            "username": username,
            "gelbooru_has_auth": bool(gelbooru_user_id and gelbooru_api_key),
            "gelbooru_user_id": gelbooru_user_id,
        }

    @staticmethod
    def _normalize_asset_url(url: str | None, base_url: str = BASE_URL) -> str | None:
        if not url:
            return None
        if url.startswith("//"):
            return f"https:{url}"
        return url if url.startswith("http") else urljoin(base_url, url)

    @staticmethod
    def _extract_error_message(response: requests.Response) -> str:
        try:
            data = response.json()
            return data.get("message") or data.get("reason") or response.text
        except (json.JSONDecodeError, ValueError):
            return response.text

    @staticmethod
    def _normalize_rating_values(rating: str | None) -> list[str]:
        if not rating or rating.lower() == "all":
            return []
        values: list[str] = []
        for raw_value in rating.split(","):
            normalized = ALLOWED_RATINGS.get(raw_value.strip().lower())
            if normalized and normalized not in values:
                values.append(normalized)
        return values

    @staticmethod
    def _normalize_before_id(before_id: str | int | None) -> str:
        if before_id is None:
            return ""
        value = str(before_id).strip()
        return value if value.isdigit() else ""

    @staticmethod
    def _can_use_before_id(tags: str) -> bool:
        for token in str(tags or "").split():
            if token.startswith(("order:", "ordfav:", "sort:")):
                return False
        return True

    @staticmethod
    def _auth_query_params(username: str, api_key: str) -> dict[str, str]:
        return {"login": username, "api_key": api_key}

    @staticmethod
    def _normalize_source(source: str | None) -> str:
        return get_site_adapter(source).key

    def _require_auth(self) -> tuple[str, str, HTTPBasicAuth]:
        username, api_key = self._credentials()
        if not username or not api_key:
            raise DanbooruFavoriteError("请先在设置中配置 Danbooru 用户名和 API Key", status_code=401)
        return username, api_key, HTTPBasicAuth(username, api_key)

    def _require_gelbooru_auth(self) -> tuple[str, str]:
        user_id, api_key = self._gelbooru_credentials()
        if not user_id or not api_key:
            raise DanbooruFavoriteError("请先在设置中配置 Gelbooru User ID 和 API Key", status_code=401)
        if not str(user_id).isdigit():
            raise DanbooruFavoriteError("Gelbooru User ID 必须是数字 ID，不是用户名", status_code=400)
        return user_id, api_key

    def _select_prompt_tags(self, post: dict) -> list[str]:
        settings = self.settings_service.load()
        selected_categories = settings.get("selected_categories", ["copyright", "character", "general"])
        blacklist = set(settings.get("blacklist", []))
        filter_enabled = settings.get("filter_enabled", True)
        filter_tags = set(settings.get("filter_tags", [])) if filter_enabled else set()

        selected = []
        for category_name, field_name in CATEGORY_FIELDS:
            if category_name not in selected_categories:
                continue
            tags = [tag for tag in (post.get(field_name) or "").split(" ") if tag]
            for tag in tags:
                if tag in blacklist or tag in filter_tags:
                    continue
                selected.append(tag)
        return selected

    def _format_post(self, post: dict, *, source: str) -> dict:
        adapter = get_site_adapter(source)
        base_url = adapter.base_url or BASE_URL
        post_id = post.get("id")
        prompt_tags = self._select_prompt_tags(post)
        preview_url = self._normalize_asset_url(post.get("preview_file_url") or post.get("preview_url"), base_url)
        sample_url = self._normalize_asset_url(
            post.get("large_file_url") or post.get("sample_file_url") or post.get("sample_url") or post.get("file_url"),
            base_url,
        )
        file_url = self._normalize_asset_url(post.get("file_url"), base_url)
        return {
            "id": post_id,
            "rating": post.get("rating"),
            "score": post.get("score", 0),
            "fav_count": post.get("fav_count", 0),
            "file_ext": post.get("file_ext"),
            "image_width": post.get("image_width"),
            "image_height": post.get("image_height"),
            "created_at": post.get("created_at"),
            "preview_url": preview_url,
            "sample_url": sample_url,
            "file_url": file_url,
            "post_url": f"{base_url}/index.php?page=post&s=view&id={post_id}" if adapter.key == "gelbooru" else f"{BASE_URL}/posts/{post_id}",
            "tag_string": post.get("tag_string", ""),
            "tag_string_artist": post.get("tag_string_artist", ""),
            "tag_string_copyright": post.get("tag_string_copyright", ""),
            "tag_string_character": post.get("tag_string_character", ""),
            "tag_string_general": post.get("tag_string_general", ""),
            "tag_string_meta": post.get("tag_string_meta", ""),
            "gallery_prompt": ", ".join(prompt_tags),
            "source_site": adapter.key,
        }

    def _gelbooru_credentials_dict(self) -> dict[str, str]:
        user_id, api_key = self._gelbooru_credentials()
        return {"user_id": user_id, "api_key": api_key}

    def _fetch_gelbooru_public_posts(self, tags: str, limit: int, page: int, rating: str | None) -> list[dict]:
        adapter = get_site_adapter("gelbooru")
        tags = self._apply_gelbooru_recent_filter(tags, adapter)
        id_match = re.search(r"(?:^|\s)id:(\d+)(?:\s|$)", tags or "")
        if id_match:
            refs = [{"id": id_match.group(1)}]
        else:
            _gelbooru_throttle.wait()
            response = requests.get(
                adapter.posts_url,
                params=adapter.build_public_posts_params(tags, page, rating, page_size=limit),
                headers=GELBOORU_BROWSER_HEADERS,
                timeout=(8, 15),
            )
            response.raise_for_status()
            refs = adapter.extract_public_post_refs(response.text, limit)

        selected_refs = refs[:limit]
        if not selected_refs:
            return []

        workers = min(4, len(selected_refs))
        # Hydrate in a small pool so public fallback does not block the UI for every detail page serially.
        with ThreadPoolExecutor(max_workers=workers) as executor:
            return list(executor.map(lambda ref: self._fetch_gelbooru_public_post_detail(adapter, ref), selected_refs))

    def _fetch_gelbooru_public_post_detail(self, adapter, ref: dict) -> dict:
        post_id = ref.get("id")
        if not post_id:
            return ref
        try:
            _gelbooru_detail_throttle.wait()
            detail_response = requests.get(
                adapter.posts_url,
                params=adapter.build_public_post_params(post_id),
                headers=GELBOORU_BROWSER_HEADERS,
                timeout=(8, 15),
            )
            detail_response.raise_for_status()
            return adapter.normalize_public_post_page(post_id, detail_response.text, ref)
        except requests.RequestException as exc:
            logger.warning(f"[Gelbooru] 详情页解析失败，使用预览数据 #{post_id}: {exc}")
            return ref

    def _apply_gelbooru_recent_filter(self, tags: str, adapter) -> str:
        raw_tags = str(tags or "")
        match = re.search(r"(?:^|\s)recent:(\d+)d(?:\s|$)", raw_tags, re.IGNORECASE)
        if not match:
            return raw_tags

        cleaned = re.sub(r"(?:^|\s)recent:\d+d(?=\s|$)", " ", raw_tags, flags=re.IGNORECASE)
        cleaned = " ".join(cleaned.split())
        if re.search(r"(?:^|\s)id:[<>]?\d+(?:\s|$)", cleaned):
            return cleaned

        days = max(1, min(365, int(match.group(1))))
        latest_id = self._get_gelbooru_latest_post_id(adapter)
        if not latest_id:
            return cleaned

        threshold = max(1, latest_id - (days * GELBOORU_APPROX_POSTS_PER_DAY))
        return f"{cleaned} id:>{threshold}".strip()

    def _get_gelbooru_latest_post_id(self, adapter) -> int | None:
        now = time.monotonic()
        if self._gelbooru_latest_id_cache and now - self._gelbooru_latest_id_cache[1] < GELBOORU_LATEST_ID_CACHE_SECONDS:
            return self._gelbooru_latest_id_cache[0]

        try:
            _gelbooru_throttle.wait()
            response = requests.get(
                adapter.posts_url,
                params=adapter.build_public_posts_params("", 1, None, page_size=1),
                headers=GELBOORU_BROWSER_HEADERS,
                timeout=(8, 12),
            )
            response.raise_for_status()
            refs = adapter.extract_public_post_refs(response.text, 1)
            latest_id = int(refs[0]["id"]) if refs and str(refs[0].get("id", "")).isdigit() else 0
        except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
            logger.warning(f"[Gelbooru] 最新 ID 获取失败，跳过近期筛选: {exc}")
            return None

        if latest_id > 0:
            self._gelbooru_latest_id_cache = (latest_id, now)
            return latest_id
        return None

    def search_posts(
        self,
        tags: str,
        limit: int,
        page: int,
        rating: str | None,
        before_id: str | int | None = None,
        source: str = "danbooru",
    ) -> list[dict]:
        adapter = get_site_adapter(source)
        if adapter.key == "gelbooru":
            return self._search_gelbooru_posts(tags=tags, limit=limit, page=page, rating=rating)

        search_tags: list[str] = []
        date_tag = None
        for raw_tag in tags.split():
            if raw_tag.startswith("date:"):
                date_tag = raw_tag
            else:
                search_tags.append(raw_tag)

        if date_tag:
            search_tags.append(date_tag)
        rating_values = self._normalize_rating_values(rating)
        if len(rating_values) == 1:
            search_tags.append(f"rating:{rating_values[0]}")
        elif len(rating_values) > 1:
            search_tags.extend(f"~rating:{value}" for value in rating_values)

        cursor = self._normalize_before_id(before_id)
        if cursor and not self._can_use_before_id(tags):
            cursor = ""
        page_param: int | str = f"b{cursor}" if cursor else page

        response = danbooru_request(
            "GET",
            f"{BASE_URL}/posts.json",
            params={"tags": " ".join(search_tags), "limit": limit, "page": page_param},
            auth=self._auth(),
            timeout=20,
        )
        response.raise_for_status()

        return [self._format_post(post, source="danbooru") for post in response.json()]

    def _search_gelbooru_posts(self, tags: str, limit: int, page: int, rating: str | None) -> list[dict]:
        adapter = get_site_adapter("gelbooru")
        tags = self._apply_gelbooru_recent_filter(tags, adapter)
        credentials = self._gelbooru_credentials_dict()
        has_credentials = bool(credentials.get("user_id") and credentials.get("api_key"))
        posts: list[dict]
        if has_credentials:
            params = adapter.apply_auth_params(adapter.build_posts_params(tags, limit, page, rating), credentials)
            response = gelbooru_api_request("GET", adapter.posts_url, params=params, timeout=20)
            if response.status_code == 401:
                logger.warning("[Gelbooru] DAPI 认证失败或不可用，回退公开网页解析")
                posts = self._fetch_gelbooru_public_posts(tags, limit, page, rating)
            else:
                response.raise_for_status()
                posts = adapter.normalize_posts_response(response.json())
        else:
            posts = self._fetch_gelbooru_public_posts(tags, limit, page, rating)
        return [self._format_post(post, source="gelbooru") for post in posts]

    def add_favorite(self, post_id: int, source: str = "danbooru") -> dict:
        if self._normalize_source(source) == "gelbooru":
            return self.add_gelbooru_favorite(post_id)

        username, api_key, auth = self._require_auth()
        response = danbooru_request(
            "POST",
            f"{BASE_URL}/favorites.json",
            params=self._auth_query_params(username, api_key),
            auth=auth,
            data={"post_id": post_id},
            timeout=15,
        )
        if response.status_code in {200, 201}:
            return {"success": True, "post_id": post_id, "message": "收藏成功"}

        message = self._extract_error_message(response)
        if response.status_code == 422 and "already favorited" in message.lower():
            return {"success": True, "post_id": post_id, "message": "已收藏，无需重复操作"}

        error_map = {
            401: "认证失败，请检查 Danbooru 用户名和 API Key",
            403: "权限不足，无法收藏该图片",
            404: "图片不存在",
            429: "请求过于频繁，请稍后重试",
        }
        raise DanbooruFavoriteError(
            error_map.get(response.status_code, f"收藏失败: {message or response.status_code}"),
            status_code=response.status_code or 502,
        )

    def add_gelbooru_favorite(self, post_id: int) -> dict:
        user_id, api_key = self._require_gelbooru_auth()
        response = gelbooru_api_request(
            "GET",
            f"{GELBOORU_BASE_URL}/public/addfav.php",
            params={"id": str(post_id), "user_id": user_id, "api_key": api_key},
            headers={"Accept": "*/*"},
            timeout=(8, 15),
        )
        response.raise_for_status()
        body = (response.text or "").strip()
        if body == "2":
            raise DanbooruFavoriteError("Gelbooru 返回未登录；该站点可能不接受 API-only 收藏", status_code=403)
        message = "已收藏，无需重复操作" if body == "1" else "收藏成功"
        return {"success": True, "post_id": post_id, "message": message}

    def remove_favorite(self, post_id: int, source: str = "danbooru") -> dict:
        if self._normalize_source(source) == "gelbooru":
            return self.remove_gelbooru_favorite(post_id)

        username, api_key, auth = self._require_auth()
        response = danbooru_request(
            "DELETE",
            f"{BASE_URL}/favorites/{post_id}.json",
            params=self._auth_query_params(username, api_key),
            auth=auth,
            timeout=15,
        )
        if response.status_code in {200, 204, 404}:
            return {"success": True, "post_id": post_id, "message": "取消收藏成功"}

        message = self._extract_error_message(response)
        error_map = {
            401: "认证失败，请检查 Danbooru 用户名和 API Key",
            403: "权限不足，无法取消收藏该图片",
            429: "请求过于频繁，请稍后重试",
        }
        raise DanbooruFavoriteError(
            error_map.get(response.status_code, f"取消收藏失败: {message or response.status_code}"),
            status_code=response.status_code or 502,
        )

    def remove_gelbooru_favorite(self, post_id: int) -> dict:
        user_id, api_key = self._require_gelbooru_auth()
        response = gelbooru_api_request(
            "GET",
            f"{GELBOORU_BASE_URL}/index.php",
            params={"page": "favorites", "s": "delete", "id": str(post_id), "user_id": user_id, "api_key": api_key},
            headers={"Accept": "text/html,*/*"},
            allow_redirects=False,
            timeout=(8, 15),
        )
        if response.status_code in {200, 302, 303, 404}:
            location = response.headers.get("Location", "")
            if "account" in location and "login" in location:
                raise DanbooruFavoriteError("Gelbooru 返回登录页；该站点可能不接受 API-only 取消收藏", status_code=403)
            return {"success": True, "post_id": post_id, "message": "取消收藏成功"}
        response.raise_for_status()
        return {"success": True, "post_id": post_id, "message": "取消收藏成功"}

    def sync_favorite_ids(self, *, page_limit: int = 200, max_pages: int = 10, source: str = "danbooru") -> dict:
        if self._normalize_source(source) == "gelbooru":
            return self.sync_gelbooru_favorite_ids(page_limit=page_limit, max_pages=max_pages)

        username, api_key, auth = self._require_auth()
        favorite_ids: list[str] = []
        truncated = False

        for page in range(1, max_pages + 1):
            response = danbooru_request(
                "GET",
                f"{BASE_URL}/posts.json",
                params={
                    "tags": f"ordfav:{username}",
                    "limit": page_limit,
                    "page": page,
                    **self._auth_query_params(username, api_key),
                },
                auth=auth,
                timeout=20,
            )
            if response.status_code != 200:
                message = self._extract_error_message(response)
                error_map = {
                    401: "认证失败，请检查 Danbooru 用户名和 API Key",
                    403: "权限不足，无法同步收藏夹",
                    429: "请求过于频繁，请稍后重试",
                }
                raise DanbooruFavoriteError(
                    error_map.get(response.status_code, f"同步收藏夹失败: {message or response.status_code}"),
                    status_code=response.status_code or 502,
                )

            posts = response.json()
            favorite_ids.extend(str(post["id"]) for post in posts if post.get("id") is not None)
            if len(posts) < page_limit:
                break
        else:
            truncated = True

        return {
            "success": True,
            "source": "danbooru",
            "username": username,
            "favorites": favorite_ids,
            "count": len(favorite_ids),
            "truncated": truncated,
        }

    def sync_gelbooru_favorite_ids(self, *, page_limit: int = 100, max_pages: int = 10) -> dict:
        user_id, api_key = self._require_gelbooru_auth()
        adapter = get_site_adapter("gelbooru")
        favorite_ids: list[str] = []
        truncated = False
        for page in range(1, max_pages + 1):
            params = adapter.apply_auth_params(adapter.build_favorites_params(user_id, min(page_limit, 100), page), {"user_id": user_id, "api_key": api_key})
            response = gelbooru_api_request("GET", adapter.posts_url, params=params, timeout=20)
            if response.status_code == 401:
                raise DanbooruFavoriteError("Gelbooru 收藏列表读取失败，请检查 User ID/API Key", status_code=401)
            response.raise_for_status()
            page_ids = [str(post.get("id")) for post in adapter.normalize_posts_response(response.json()) if post.get("id") is not None]
            favorite_ids.extend(page_ids)
            if len(page_ids) < min(page_limit, 100):
                break
        else:
            truncated = True
        return {
            "success": True,
            "source": "gelbooru",
            "username": user_id,
            "favorites": favorite_ids,
            "count": len(favorite_ids),
            "truncated": truncated,
        }

    async def autocomplete(self, query: str, limit: int, include_translation: bool = True, source: str = "danbooru") -> list[dict]:
        if not query:
            return []

        adapter = get_site_adapter(source)
        if adapter.key == "danbooru":
            try:
                db_results = await self.db_manager.search_tags_by_prefix(query, limit)
                if db_results:
                    return [
                        {
                            "name": item["tag"],
                            "category": item["category"],
                            "post_count": item["post_count"],
                            "translation": item.get("translation_cn") if include_translation else None,
                            "aliases": item.get("aliases", []),
                        }
                        for item in db_results
                    ]
            except Exception as exc:
                logger.warning(f"[Autocomplete] 数据库查询失败: {exc}")

        if adapter.key == "gelbooru":
            return self._autocomplete_gelbooru(query=query, limit=limit, include_translation=include_translation)

        response = danbooru_request(
            "GET",
            f"{BASE_URL}/tags.json",
            params={
                "search[name_or_alias_matches]": f"{query}*",
                "search[order]": "count",
                "limit": limit,
            },
            auth=self._auth(),
            timeout=8,
        )
        response.raise_for_status()
        results = []
        for item in response.json():
            results.append(
                {
                    "name": item.get("name", ""),
                    "category": item.get("category", 0),
                    "post_count": item.get("post_count", 0),
                    "translation": self.translation_loader.get_chinese(item.get("name", "")) if include_translation else None,
                    "aliases": item.get("words", []),
                }
            )
        return results

    def _autocomplete_gelbooru(self, query: str, limit: int, include_translation: bool) -> list[dict]:
        adapter = get_site_adapter("gelbooru")
        credentials = self._gelbooru_credentials_dict()
        has_credentials = bool(credentials.get("user_id") and credentials.get("api_key"))
        if has_credentials:
            params = adapter.apply_auth_params(adapter.build_autocomplete_params(query, limit), credentials)
            response = gelbooru_api_request("GET", adapter.tags_url, params=params, timeout=8)
            if response.status_code != 401:
                response.raise_for_status()
                results = adapter.normalize_autocomplete_response(response.json())
                for item in results:
                    item["translation"] = self.translation_loader.get_chinese(item.get("name", "")) if include_translation else None
                    item["aliases"] = []
                return results

        response = requests.get(
            adapter.tags_url,
            params=adapter.build_public_autocomplete_params(query, limit),
            headers=GELBOORU_BROWSER_HEADERS,
            timeout=8,
        )
        response.raise_for_status()
        results = adapter.normalize_public_autocomplete_response(response.json())
        for item in results:
            item["translation"] = self.translation_loader.get_chinese(item.get("name", "")) if include_translation else None
            item["aliases"] = []
        return results

    async def search_chinese(self, query: str, limit: int) -> list[dict]:
        if not query:
            return []
        db_results = await self.db_manager.search_tags_optimized(query, limit, search_type="chinese")
        if not db_results:
            fallback_results = []
            for english_tag, chinese_translation in self.translation_loader.search_chinese(query, limit):
                tag_info = await self.db_manager.get_tag(english_tag)
                fallback_results.append(
                    {
                        "tag": english_tag,
                        "translation_cn": chinese_translation,
                        "category": tag_info["category"] if tag_info else 0,
                        "post_count": tag_info["post_count"] if tag_info else 0,
                        "match_score": 3,
                    }
                )
            return fallback_results
        return [
            {
                "tag": item["tag"],
                "translation_cn": item.get("translation_cn"),
                "category": item["category"],
                "post_count": item["post_count"],
                "match_score": item.get("match_score", 0),
            }
            for item in db_results
        ]

    def translate_tags_batch(self, tags: Iterable[str]) -> dict[str, str]:
        return {
            tag: self.translation_loader.get_chinese(tag)
            for tag in tags
            if tag and self.translation_loader.get_chinese(tag)
        }
