from __future__ import annotations

import html
import re
import urllib.parse
from typing import Any


class GallerySiteAdapter:
    key = ""
    base_url = ""
    supports_favorites = False

    @property
    def posts_url(self) -> str:
        raise NotImplementedError

    @property
    def tags_url(self) -> str:
        raise NotImplementedError

    def build_posts_params(self, tags: str, limit: int, page: int, rating: str | None) -> dict[str, Any]:
        raise NotImplementedError

    def build_autocomplete_params(self, query: str, limit: int) -> dict[str, Any]:
        raise NotImplementedError

    def apply_auth_params(self, params: dict[str, Any], credentials: dict[str, str]) -> dict[str, Any]:
        return params

    def normalize_posts_response(self, payload: Any) -> list[dict[str, Any]]:
        return payload if isinstance(payload, list) else []

    def normalize_autocomplete_response(self, payload: Any) -> list[dict[str, Any]]:
        return payload if isinstance(payload, list) else []


class DanbooruAdapter(GallerySiteAdapter):
    key = "danbooru"
    base_url = "https://danbooru.donmai.us"
    supports_favorites = True

    @property
    def posts_url(self) -> str:
        return f"{self.base_url}/posts.json"

    @property
    def tags_url(self) -> str:
        return f"{self.base_url}/tags.json"

    def build_posts_params(self, tags: str, limit: int, page: int, rating: str | None) -> dict[str, Any]:
        return {"tags": tags.strip(), "limit": limit, "page": page}

    def build_autocomplete_params(self, query: str, limit: int) -> dict[str, Any]:
        return {
            "search[name_or_alias_matches]": f"{query}*",
            "search[order]": "count",
            "limit": limit,
        }


class GelbooruAdapter(GallerySiteAdapter):
    key = "gelbooru"
    base_url = "https://gelbooru.com"
    supports_favorites = True

    @property
    def posts_url(self) -> str:
        return f"{self.base_url}/index.php"

    @property
    def tags_url(self) -> str:
        return f"{self.base_url}/index.php"

    def build_posts_params(self, tags: str, limit: int, page: int, rating: str | None) -> dict[str, Any]:
        params = {
            "page": "dapi",
            "s": "post",
            "q": "index",
            "json": "1",
            "tags": tags.strip(),
            "limit": limit,
            "pid": max(page - 1, 0),
        }
        rating_query = self._rating_query(rating)
        if rating_query:
            params["tags"] = f"{params['tags']} {rating_query}".strip()
        return params

    def build_public_posts_params(self, tags: str, page: int, rating: str | None, page_size: int = 42) -> dict[str, Any]:
        public_tags = tags.strip()
        rating_query = self._rating_query(rating)
        if rating_query:
            public_tags = f"{public_tags} {rating_query}".strip()
        offset_step = max(1, int(page_size or 42))
        return {
            "page": "post",
            "s": "list",
            "tags": public_tags,
            "pid": max(page - 1, 0) * offset_step,
        }

    def build_public_post_params(self, post_id: Any) -> dict[str, Any]:
        return {"page": "post", "s": "view", "id": str(post_id)}

    def build_favorites_params(self, user_id: str, limit: int, page: int) -> dict[str, Any]:
        return self.build_posts_params(f"fav:{user_id}", limit, page, None)

    def build_autocomplete_params(self, query: str, limit: int) -> dict[str, Any]:
        return {
            "page": "dapi",
            "s": "tag",
            "q": "index",
            "json": "1",
            "name_pattern": f"{query}%",
            "orderby": "count",
            "order": "DESC",
            "limit": limit,
        }

    def build_public_autocomplete_params(self, query: str, limit: int) -> dict[str, Any]:
        return {
            "page": "autocomplete2",
            "type": "tag_query",
            "term": query,
            "limit": limit,
        }

    def apply_auth_params(self, params: dict[str, Any], credentials: dict[str, str]) -> dict[str, Any]:
        user_id = (credentials.get("user_id") or "").strip()
        api_key = (credentials.get("api_key") or "").strip()
        if not user_id or not api_key:
            return params
        return {**params, "user_id": user_id, "api_key": api_key}

    def normalize_posts_response(self, payload: Any) -> list[dict[str, Any]]:
        return [self._normalize_post(post) for post in self._extract_list(payload) if isinstance(post, dict)]

    def normalize_autocomplete_response(self, payload: Any) -> list[dict[str, Any]]:
        normalized = []
        for tag in self._extract_list(payload):
            if not isinstance(tag, dict):
                continue
            name = tag.get("name") or tag.get("tag")
            if not name:
                continue
            normalized.append(
                {
                    "name": name,
                    "category": tag.get("type") or tag.get("category", 0),
                    "post_count": self._to_int(tag.get("count") or tag.get("post_count")),
                }
            )
        normalized.sort(key=lambda item: item.get("post_count", 0), reverse=True)
        return normalized

    def normalize_public_autocomplete_response(self, payload: Any) -> list[dict[str, Any]]:
        if not isinstance(payload, list):
            return []
        normalized = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            name = item.get("value") or item.get("label")
            if not name:
                continue
            normalized.append(
                {
                    "name": name,
                    "category": item.get("category", "tag"),
                    "post_count": self._to_int(item.get("post_count")),
                }
            )
        normalized.sort(key=lambda item: item.get("post_count", 0), reverse=True)
        return normalized

    def normalize_favorites_response(self, payload: Any) -> list[str]:
        ids = []
        for item in self._extract_list(payload):
            if not isinstance(item, dict):
                continue
            post_id = item.get("favorite") or item.get("post_id") or item.get("id")
            if post_id:
                ids.append(str(post_id))
        return ids

    def extract_public_post_refs(self, html_text: str, limit: int) -> list[dict[str, Any]]:
        refs = []
        seen = set()
        anchor_re = re.compile(
            r"<a\b[^>]*href=(?P<quote>['\"])(?P<href>[^'\"]*page=post[^'\"]*s=view[^'\"]*)"
            r"(?P=quote)[^>]*>(?P<body>[\s\S]*?)</a>",
            re.IGNORECASE,
        )
        for match in anchor_re.finditer(html_text or ""):
            href = self._decode_html(match.group("href"))
            post_id = self._query_param(href, "id")
            if not post_id or post_id in seen:
                continue
            body = match.group("body")
            preview_url = self._absolute_url(self._extract_attr(body, "data-src") or self._extract_attr(body, "src"))
            title = self._extract_attr(body, "title") or self._extract_attr(body, "alt")
            tag_string = self._tags_from_title(title)
            refs.append(
                {
                    "id": post_id,
                    "preview_file_url": preview_url,
                    "large_file_url": preview_url,
                    "file_url": preview_url,
                    "tag_string": tag_string,
                    "tag_string_artist": "",
                    "tag_string_copyright": "",
                    "tag_string_character": "",
                    "tag_string_general": tag_string,
                    "tag_string_meta": "",
                    "image_width": 0,
                    "image_height": 0,
                    "rating": self._rating_from_tags(tag_string.split()),
                    "source_site": self.key,
                    "_gelbooru_preview_only": True,
                }
            )
            seen.add(post_id)
            if len(refs) >= limit:
                break
        return refs

    def normalize_public_post_page(self, post_id: Any, html_text: str, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
        fallback = fallback or {}
        tag_groups = self._extract_tag_groups(html_text)
        all_tags = []
        for category in ("artist", "copyright", "character", "general", "meta"):
            all_tags.extend(tag_groups.get(category, []))
        tag_string = " ".join(all_tags) or fallback.get("tag_string", "")
        file_url = self._extract_public_file_url(html_text) or fallback.get("file_url", "")
        preview_url = fallback.get("preview_file_url") or file_url
        width, height = self._extract_image_dimensions(html_text)
        file_ext = file_url.rsplit(".", 1)[-1].split("?", 1)[0].lower() if "." in file_url else ""
        return {
            "id": str(post_id),
            "file_url": file_url,
            "large_file_url": file_url,
            "preview_file_url": preview_url,
            "tag_string": tag_string,
            "tag_string_artist": " ".join(tag_groups.get("artist", [])),
            "tag_string_copyright": " ".join(tag_groups.get("copyright", [])),
            "tag_string_character": " ".join(tag_groups.get("character", [])),
            "tag_string_general": " ".join(tag_groups.get("general", [])) or tag_string,
            "tag_string_meta": " ".join(tag_groups.get("meta", [])),
            "image_width": width or fallback.get("image_width", 0),
            "image_height": height or fallback.get("image_height", 0),
            "file_ext": file_ext or fallback.get("file_ext", ""),
            "rating": self._rating_from_tags(all_tags) or fallback.get("rating", ""),
            "created_at": fallback.get("created_at", ""),
            "source_site": self.key,
        }

    def _normalize_post(self, post: dict[str, Any]) -> dict[str, Any]:
        tags = (post.get("tags") or post.get("tag_string") or "").strip()
        file_url = post.get("file_url") or ""
        preview_url = post.get("preview_url") or post.get("preview_file_url") or post.get("sample_url") or file_url
        sample_url = post.get("sample_url") or post.get("large_file_url") or file_url
        return {
            **post,
            "id": post.get("id"),
            "file_url": file_url,
            "large_file_url": sample_url,
            "preview_file_url": preview_url,
            "tag_string": tags,
            "tag_string_artist": post.get("tag_string_artist", ""),
            "tag_string_copyright": post.get("tag_string_copyright", ""),
            "tag_string_character": post.get("tag_string_character", ""),
            "tag_string_general": post.get("tag_string_general", "") or tags,
            "tag_string_meta": post.get("tag_string_meta", ""),
            "image_width": self._to_int(post.get("width") or post.get("image_width")),
            "image_height": self._to_int(post.get("height") or post.get("image_height")),
            "created_at": post.get("created_at") or post.get("created") or "",
            "file_ext": post.get("file_ext") or file_url.rsplit(".", 1)[-1].split("?", 1)[0].lower(),
            "rating": self._normalize_rating(post.get("rating")),
            "source_site": self.key,
        }

    def _rating_query(self, rating: str | None) -> str:
        if not rating or rating.lower() == "all":
            return ""
        rating_map = {"g": "general", "s": "sensitive", "q": "questionable", "e": "explicit"}
        values = [rating_map.get(item.strip().lower(), item.strip().lower()) for item in rating.split(",") if item.strip()]
        values = [value for value in values if value and value != "all"]
        if not values:
            return ""
        if len(values) == 1:
            return f"rating:{values[0]}"
        return " ".join(f"~rating:{value}" for value in values)

    def _normalize_rating(self, rating: Any) -> str:
        rating_map = {
            "safe": "general",
            "general": "general",
            "sensitive": "sensitive",
            "questionable": "questionable",
            "explicit": "explicit",
        }
        return rating_map.get(str(rating or "").lower(), str(rating or "").lower())

    def _extract_list(self, payload: Any) -> list[Any]:
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("post", "posts", "tag", "tags"):
                value = payload.get(key)
                if isinstance(value, list):
                    return value
                if isinstance(value, dict):
                    return [value]
        return []

    def _extract_tag_groups(self, html_text: str) -> dict[str, list[str]]:
        tag_groups = {key: [] for key in ("artist", "copyright", "character", "general", "meta")}
        tag_list = re.search(r"<ul\b[^>]*id=(?P<quote>['\"])tag-list(?P=quote)[^>]*>(?P<body>[\s\S]*?)</ul>", html_text or "", re.IGNORECASE)
        if not tag_list:
            return tag_groups
        for match in re.finditer(r"<li\b(?P<attrs>[^>]*)>(?P<body>[\s\S]*?)</li>", tag_list.group("body"), re.IGNORECASE):
            classes = self._extract_attr(match.group("attrs"), "class")
            type_match = re.search(r"\btag-type-([a-z_-]+)\b", classes, re.IGNORECASE)
            category = self._map_public_tag_type(type_match.group(1) if type_match else "general")
            tag = self._extract_tag_from_item(match.group("body"))
            if tag and tag not in tag_groups[category]:
                tag_groups[category].append(tag)
        return tag_groups

    def _extract_tag_from_item(self, item_html: str) -> str:
        href_re = re.compile(r"href=(?P<quote>['\"])(?P<href>[^'\"]*page=post[^'\"]*tags=[^'\"]+)(?P=quote)", re.IGNORECASE)
        for match in href_re.finditer(item_html or ""):
            tag = self._query_param(self._decode_html(match.group("href")), "tags")
            if tag and " " not in tag and not tag.startswith("-"):
                return tag
        return ""

    def _extract_public_file_url(self, html_text: str) -> str:
        image_tag = re.search(r"<img\b(?=[^>]*id=(?P<quote>['\"])image(?P=quote))[^>]*>", html_text or "", re.IGNORECASE)
        if image_tag:
            for attr in ("data-full-url", "data-original", "data-src", "src"):
                url = self._absolute_url(self._extract_attr(image_tag.group(0), attr))
                if url and "/thumbnail" not in url.lower():
                    return url
        match = re.search(r"(?P<url>(?:https?:)?//[^'\"\s<>]*gelbooru\.com/(?:images|samples)/[^'\"\s<>]+\.(?:jpg|jpeg|png|gif|webp|webm|mp4)(?:\?[^'\"\s<>]*)?)", html_text or "", re.IGNORECASE)
        return self._absolute_url(self._decode_html(match.group("url"))) if match else ""

    def _extract_image_dimensions(self, html_text: str) -> tuple[int, int]:
        image_tag = re.search(r"<img\b(?=[^>]*id=(?P<quote>['\"])image(?P=quote))[^>]*>", html_text or "", re.IGNORECASE)
        if not image_tag:
            return 0, 0
        return self._to_int(self._extract_attr(image_tag.group(0), "width")), self._to_int(self._extract_attr(image_tag.group(0), "height"))

    def _map_public_tag_type(self, tag_type: str) -> str:
        return {
            "artist": "artist",
            "copyright": "copyright",
            "character": "character",
            "metadata": "meta",
            "meta": "meta",
            "general": "general",
        }.get((tag_type or "").lower(), "general")

    def _rating_from_tags(self, tags: list[str]) -> str:
        for tag in tags:
            if tag.startswith("rating:"):
                return self._normalize_rating(tag.split(":", 1)[1])
        return ""

    def _tags_from_title(self, value: str | None) -> str:
        value = self._decode_html(value or "")
        value = re.sub(r"\b(?:score|rating|size|user):[^\s]+", "", value)
        return " ".join(tag for tag in value.split() if tag and not tag.startswith("-"))

    def _query_param(self, value: str, key: str) -> str:
        try:
            parsed = urllib.parse.urlparse(value)
            params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            return self._decode_html(params.get(key, [""])[0]).strip()
        except Exception:
            return ""

    def _extract_attr(self, html_text: str, name: str) -> str:
        match = re.search(rf"\b{re.escape(name)}=(?P<quote>['\"])(?P<value>.*?)(?P=quote)", html_text or "", re.IGNORECASE)
        return self._decode_html(match.group("value")).strip() if match else ""

    def _absolute_url(self, value: str | None) -> str:
        if not value:
            return ""
        value = self._decode_html(value).strip()
        if value.startswith("//"):
            return f"https:{value}"
        if value.startswith("/"):
            return urllib.parse.urljoin(self.base_url, value)
        return value

    def _decode_html(self, value: str) -> str:
        return html.unescape(value or "")

    def _to_int(self, value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0


ADAPTERS = {
    DanbooruAdapter.key: DanbooruAdapter(),
    GelbooruAdapter.key: GelbooruAdapter(),
}


def get_site_adapter(source: str | None) -> GallerySiteAdapter:
    source_key = (source or "danbooru").strip().lower()
    return ADAPTERS.get(source_key, ADAPTERS["danbooru"])
