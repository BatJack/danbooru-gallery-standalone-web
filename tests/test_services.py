from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.paths import DEFAULT_SETTINGS
from app.services.danbooru_service import DanbooruService
from app.services.prompt_library_service import PromptLibraryService
from app.services.settings_service import SettingsService


class SettingsServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.settings_file = Path(self.temp_dir.name) / "settings.json"
        self.service = SettingsService(settings_file=self.settings_file)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_load_returns_defaults_when_file_missing(self) -> None:
        data = self.service.load()
        self.assertEqual(data["language"], DEFAULT_SETTINGS["language"])
        self.assertEqual(data["selected_categories"], DEFAULT_SETTINGS["selected_categories"])
        self.assertEqual(data["high_quality_previews"], DEFAULT_SETTINGS["high_quality_previews"])
        self.assertEqual(data["source_site"], "danbooru")
        self.assertEqual(data["default_source_site"], "danbooru")
        self.assertEqual(data["gelbooru_user_id"], "")
        self.assertEqual(data["gelbooru_api_key"], "")

    def test_save_persists_known_fields_and_ignores_unknown_or_none(self) -> None:
        saved = self.service.save(
            {
                "danbooru_username": "alice",
                "selected_categories": ["artist", "general"],
                "high_quality_previews": False,
                "autocomplete_max_results": 12,
                "default_source_site": "gelbooru",
                "unknown_key": "ignored",
                "danbooru_api_key": None,
            }
        )

        self.assertEqual(saved["danbooru_username"], "alice")
        self.assertEqual(saved["selected_categories"], ["artist", "general"])
        self.assertFalse(saved["high_quality_previews"])
        self.assertEqual(saved["autocomplete_max_results"], 12)
        self.assertEqual(saved["default_source_site"], "gelbooru")
        self.assertNotIn("unknown_key", saved)
        self.assertEqual(saved["danbooru_api_key"], DEFAULT_SETTINGS["danbooru_api_key"])

        reloaded = self.service.load()
        self.assertEqual(reloaded, saved)


class PromptLibraryServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.library_file = Path(self.temp_dir.name) / "prompt_library.json"
        self.service = PromptLibraryService(library_file=self.library_file)
        self.service.save(
            {
                "version": "1.6",
                "categories": [],
                "settings": {"language": "zh-CN", "separator": ", ", "save_selection": True},
            }
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_category_and_prompt_crud_roundtrip(self) -> None:
        self.service.create_category("Category A")
        self.service.create_category("Category B")
        self.service.rename_category("Category A", "Category Alpha")

        data = self.service.add_prompt(
            {
                "category": "Category Alpha",
                "alias": "Starter",
                "prompt": "1girl, solo",
                "description": "base prompt",
                "tags": ["portrait", "solo"],
            }
        )
        category_alpha = next(category for category in data["categories"] if category["name"] == "Category Alpha")
        prompt = category_alpha["prompts"][0]
        prompt_id = prompt["id"]

        updated = self.service.update_prompt(
            prompt_id,
            {
                "category": "Category B",
                "alias": "Starter v2",
                "prompt": "1girl, solo, masterpiece",
                "description": "updated",
                "tags": ["portrait", "solo", "masterpiece"],
            },
        )
        category_b = next(category for category in updated["categories"] if category["name"] == "Category B")
        moved_prompt = next(item for item in category_b["prompts"] if item["id"] == prompt_id)
        self.assertEqual(moved_prompt["alias"], "Starter v2")
        self.assertEqual(moved_prompt["prompt"], "1girl, solo, masterpiece")
        self.assertEqual(moved_prompt["description"], "updated")
        self.assertEqual(moved_prompt["tags"], ["portrait", "solo", "masterpiece"])

        favorited = self.service.toggle_favorite(prompt_id)
        category_b = next(category for category in favorited["categories"] if category["name"] == "Category B")
        toggled_prompt = next(item for item in category_b["prompts"] if item["id"] == prompt_id)
        self.assertTrue(toggled_prompt["favorite"])

        deleted_prompt = self.service.delete_prompt(prompt_id)
        category_b = next(category for category in deleted_prompt["categories"] if category["name"] == "Category B")
        self.assertEqual(category_b["prompts"], [])

        deleted_category = self.service.delete_category("Category Alpha")
        self.assertFalse(any(category["name"] == "Category Alpha" for category in deleted_category["categories"]))


class DanbooruServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.settings_file = Path(self.temp_dir.name) / "settings.json"
        self.settings_service = SettingsService(settings_file=self.settings_file)
        self.db_manager = Mock()
        self.service = DanbooruService(db_manager=self.db_manager, settings_service=self.settings_service)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_search_posts_uses_descriptive_user_agent_and_multi_rating_or_syntax(self) -> None:
        response = Mock()
        response.status_code = 200
        response.headers = {}
        response.json.return_value = [
            {
                "id": 123,
                "rating": "g",
                "score": 10,
                "fav_count": 2,
                "file_ext": "jpg",
                "image_width": 1000,
                "image_height": 1400,
                "created_at": "2026-05-15T00:00:00.000-04:00",
                "preview_file_url": "/preview.jpg",
                "large_file_url": "/large.jpg",
                "file_url": "/full.jpg",
                "tag_string": "artist_tag copyright_tag general_tag",
                "tag_string_artist": "artist_tag",
                "tag_string_copyright": "copyright_tag",
                "tag_string_character": "",
                "tag_string_general": "general_tag",
                "tag_string_meta": "",
            }
        ]

        with (
            patch("app.services.danbooru_service._donmai_throttle.wait", return_value=None),
            patch("app.services.danbooru_service.requests.request", return_value=response) as request_mock,
        ):
            results = self.service.search_posts("1girl order:rank", limit=20, page=1, rating="general,sensitive")

        self.assertEqual(results[0]["id"], 123)
        _, called_url = request_mock.call_args.args[:2]
        self.assertEqual(called_url, "https://danbooru.donmai.us/posts.json")
        self.assertEqual(
            request_mock.call_args.kwargs["headers"]["User-Agent"],
            "Danbooru-Gallery/1.0",
        )
        self.assertEqual(request_mock.call_args.kwargs["params"]["limit"], 20)
        self.assertEqual(request_mock.call_args.kwargs["params"]["page"], 1)
        self.assertEqual(
            request_mock.call_args.kwargs["params"]["tags"],
            "1girl order:rank ~rating:general ~rating:sensitive",
        )

    def test_search_posts_uses_before_id_cursor_for_plain_queries(self) -> None:
        response = Mock()
        response.status_code = 200
        response.headers = {}
        response.json.return_value = []

        with (
            patch("app.services.danbooru_service._donmai_throttle.wait", return_value=None),
            patch("app.services.danbooru_service.requests.request", return_value=response) as request_mock,
        ):
            self.service.search_posts("1girl solo", limit=20, page=3, rating="all", before_id="123456")

        self.assertEqual(request_mock.call_args.kwargs["params"]["page"], "b123456")

    def test_search_posts_ignores_before_id_for_ordered_queries(self) -> None:
        response = Mock()
        response.status_code = 200
        response.headers = {}
        response.json.return_value = []

        with (
            patch("app.services.danbooru_service._donmai_throttle.wait", return_value=None),
            patch("app.services.danbooru_service.requests.request", return_value=response) as request_mock,
        ):
            self.service.search_posts("1girl order:rank", limit=20, page=3, rating="all", before_id="123456")

        self.assertEqual(request_mock.call_args.kwargs["params"]["page"], 3)

    def test_favorite_mutations_include_auth_query_params(self) -> None:
        self.settings_service.save({"danbooru_username": "tester", "danbooru_api_key": "secret"})

        add_response = Mock()
        add_response.status_code = 201
        add_response.headers = {}
        remove_response = Mock()
        remove_response.status_code = 204
        remove_response.headers = {}

        with (
            patch("app.services.danbooru_service._donmai_throttle.wait", return_value=None),
            patch(
                "app.services.danbooru_service.requests.request",
                side_effect=[add_response, remove_response],
            ) as request_mock,
        ):
            self.service.add_favorite(1001)
            self.service.remove_favorite(1001)

        add_kwargs = request_mock.call_args_list[0].kwargs
        remove_kwargs = request_mock.call_args_list[1].kwargs
        self.assertEqual(add_kwargs["params"], {"login": "tester", "api_key": "secret"})
        self.assertEqual(remove_kwargs["params"], {"login": "tester", "api_key": "secret"})
        self.assertEqual(add_kwargs["data"], {"post_id": 1001})

    def test_sync_favorites_include_auth_query_params(self) -> None:
        self.settings_service.save({"danbooru_username": "tester", "danbooru_api_key": "secret"})

        response = Mock()
        response.status_code = 200
        response.headers = {}
        response.json.return_value = []

        with (
            patch("app.services.danbooru_service._donmai_throttle.wait", return_value=None),
            patch("app.services.danbooru_service.requests.request", return_value=response) as request_mock,
        ):
            self.service.sync_favorite_ids(page_limit=50, max_pages=1)

        params = request_mock.call_args.kwargs["params"]
        self.assertEqual(params["tags"], "ordfav:tester")
        self.assertEqual(params["login"], "tester")
        self.assertEqual(params["api_key"], "secret")

    def test_search_posts_supports_gelbooru_public_fallback(self) -> None:
        list_response = Mock()
        list_response.status_code = 200
        list_response.text = """
            <a href="index.php?page=post&amp;s=view&amp;id=42">
                <img src="//gelbooru.com/thumbnails/ab/cd/thumb.jpg" title="1girl blue_hair rating:general">
            </a>
        """
        list_response.raise_for_status.return_value = None

        detail_response = Mock()
        detail_response.status_code = 200
        detail_response.text = """
            <ul id="tag-list">
                <li class="tag-type-artist"><a href="index.php?page=post&amp;s=list&amp;tags=artist_tag">artist_tag</a></li>
                <li class="tag-type-character"><a href="index.php?page=post&amp;s=list&amp;tags=character_tag">character_tag</a></li>
                <li class="tag-type-general"><a href="index.php?page=post&amp;s=list&amp;tags=blue_hair">blue_hair</a></li>
            </ul>
            <img id="image" src="//gelbooru.com/images/ab/cd/full.jpg" width="800" height="600">
        """
        detail_response.raise_for_status.return_value = None

        with (
            patch("app.services.danbooru_service._gelbooru_throttle.wait", return_value=None),
            patch("app.services.danbooru_service._gelbooru_detail_throttle.wait", return_value=None),
            patch("app.services.danbooru_service.requests.get", side_effect=[list_response, detail_response]) as get_mock,
        ):
            results = self.service.search_posts("1girl", limit=1, page=1, rating="general", source="gelbooru")

        self.assertEqual(results[0]["id"], "42")
        self.assertEqual(results[0]["source_site"], "gelbooru")
        self.assertEqual(results[0]["image_width"], 800)
        self.assertEqual(results[0]["file_url"], "https://gelbooru.com/images/ab/cd/full.jpg")
        self.assertIn("character_tag", results[0]["tag_string_character"])
        self.assertEqual(get_mock.call_count, 2)
        self.assertEqual(get_mock.call_args_list[0].kwargs["params"]["pid"], 0)

    def test_gelbooru_public_fallback_offsets_by_requested_batch_size(self) -> None:
        response = Mock()
        response.status_code = 200
        response.text = ""
        response.raise_for_status.return_value = None

        with (
            patch("app.services.danbooru_service._gelbooru_throttle.wait", return_value=None),
            patch("app.services.danbooru_service.requests.get", return_value=response) as get_mock,
        ):
            results = self.service.search_posts("1girl", limit=20, page=2, rating="all", source="gelbooru")

        self.assertEqual(results, [])
        self.assertEqual(get_mock.call_args.kwargs["params"]["pid"], 20)

    def test_gelbooru_recent_token_converts_to_id_threshold(self) -> None:
        adapter = self.service._normalize_source("gelbooru")
        self.assertEqual(adapter, "gelbooru")

        with patch.object(self.service, "_get_gelbooru_latest_post_id", return_value=14465041):
            result = self.service._apply_gelbooru_recent_filter(
                "sort:score recent:7d rating:general",
                Mock(),
            )

        self.assertEqual(result, "sort:score rating:general id:>14381041")

    def test_gelbooru_authenticated_search_uses_fast_api_request(self) -> None:
        self.settings_service.save({"gelbooru_user_id": "12345", "gelbooru_api_key": "secret"})
        response = Mock()
        response.status_code = 200
        response.headers = {}
        response.json.return_value = {
            "post": [
                {
                    "id": 88,
                    "rating": "general",
                    "score": 5,
                    "file_url": "https://gelbooru.com/images/a/b/full.jpg",
                    "preview_url": "https://gelbooru.com/thumbnails/a/b/thumb.jpg",
                    "tags": "1girl solo",
                    "width": 1200,
                    "height": 1600,
                }
            ]
        }

        with patch("app.services.danbooru_service.gelbooru_api_request", return_value=response) as request_mock:
            results = self.service.search_posts("1girl", limit=20, page=1, rating="general", source="gelbooru")

        self.assertEqual(results[0]["id"], 88)
        self.assertEqual(results[0]["source_site"], "gelbooru")
        params = request_mock.call_args.kwargs["params"]
        self.assertEqual(params["user_id"], "12345")
        self.assertEqual(params["api_key"], "secret")
        self.assertEqual(params["tags"], "1girl rating:general")

    def test_autocomplete_supports_gelbooru_public_endpoint(self) -> None:
        response = Mock()
        response.status_code = 200
        response.json.return_value = [
            {"type": "tag", "label": "1girl", "value": "1girl", "post_count": "123", "category": "tag"}
        ]
        response.raise_for_status.return_value = None

        with patch("app.services.danbooru_service.requests.get", return_value=response) as get_mock:
            import asyncio

            results = asyncio.run(self.service.autocomplete("1girl", limit=3, source="gelbooru"))

        self.assertEqual(results[0]["name"], "1girl")
        self.assertEqual(results[0]["category"], "tag")
        self.assertEqual(results[0]["post_count"], 123)
        self.assertEqual(get_mock.call_args.kwargs["params"]["page"], "autocomplete2")


if __name__ == "__main__":
    unittest.main()
