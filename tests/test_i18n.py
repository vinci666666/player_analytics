import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_JS = ROOT / "web" / "app.js"
INDEX_HTML = ROOT / "web" / "index.html"


def translation_keys(source, language):
    match = re.search(
        rf"^  {language}: \{{(?P<body>.*?)^  \}}[,]?$",
        source,
        flags=re.MULTILINE | re.DOTALL,
    )
    if not match:
        raise AssertionError(f"Unable to find {language} translation block")
    return set(re.findall(r"^    ,?([A-Za-z][A-Za-z0-9]*):", match.group("body"), re.MULTILINE))


def translation_entries(source, language):
    match = re.search(
        rf"^  {language}: \{{(?P<body>.*?)^  \}}[,]?$",
        source,
        flags=re.MULTILINE | re.DOTALL,
    )
    if not match:
        raise AssertionError(f"Unable to find {language} translation block")
    return dict(re.findall(r'^    ,?([A-Za-z][A-Za-z0-9]*):\s*["\'](.*)["\'],?$', match.group("body"), re.MULTILINE))


class I18nTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app_source = APP_JS.read_text(encoding="utf-8")
        cls.html_source = INDEX_HTML.read_text(encoding="utf-8")

    def test_translation_locales_have_matching_keys(self):
        self.assertSetEqual(
            translation_keys(self.app_source, "en"),
            translation_keys(self.app_source, "zh"),
        )

    def test_translation_placeholders_match(self):
        english = translation_entries(self.app_source, "en")
        chinese = translation_entries(self.app_source, "zh")
        for key in english.keys() & chinese.keys():
            with self.subTest(key=key):
                self.assertSetEqual(
                    set(re.findall(r"\{[A-Za-z][A-Za-z0-9]*\}", english[key])),
                    set(re.findall(r"\{[A-Za-z][A-Za-z0-9]*\}", chinese[key])),
                )

    def test_default_document_language_matches_default_ui_language(self):
        self.assertIn('<html lang="zh-Hant">', self.html_source)
        self.assertRegex(self.app_source, r"let currentLang = 'zh';")

    def test_agent_controls_have_translatable_hooks(self):
        required_ids = {
            "agent-label-parent",
            "agent-label-agent",
            "agent-label-game",
            "agent-label-start-date",
            "agent-label-end-date",
            "agent-game-daily-bet-title",
            "home-agent-sort-hint",
        }
        for element_id in required_ids:
            with self.subTest(element_id=element_id):
                self.assertIn(f'id="{element_id}"', self.html_source)

    def test_player_game_filter_and_single_player_navigation_are_wired(self):
        for element_id in ("label-player-game", "player-game-select", "btn-open-single-player"):
            with self.subTest(element_id=element_id):
                self.assertIn(f'id="{element_id}"', self.html_source)
        self.assertIn("fetch('/api/player-games'", self.app_source)
        self.assertGreaterEqual(
            self.app_source.count("queryParams.set('slot_id', playerGameSelect.value || 'ALL')"),
            2,
        )
        self.assertIn("loadSinglePlayerData(playerId)", self.app_source)
        self.assertIn("setActivePage('single-player')", self.app_source)

    def test_api_error_payloads_are_not_rendered_as_ui_copy(self):
        for expression in ("data.error", "rows.error", "records.error", "payload.error"):
            with self.subTest(expression=expression):
                self.assertNotIn(expression, self.app_source)

    def test_game_names_do_not_fall_back_to_visible_slot_ids(self):
        forbidden_fallbacks = (
            "row.game_name || row.slot_id",
            "row.game_name || String(row.slot_id)",
            "game.game_name || String(game.slot_id",
        )
        for expression in forbidden_fallbacks:
            with self.subTest(expression=expression):
                self.assertNotIn(expression, self.app_source)
        self.assertIn('gameOption: "{name}"', self.app_source)
        self.assertNotIn("text: gsDataset.map(r => r.slot_id)", self.app_source)

    def test_bet_types_use_labels_without_numeric_prefixes(self):
        self.assertNotIn("Bet 1 ·", self.app_source)
        self.assertNotIn("Bet 2 ·", self.app_source)
        self.assertNotIn("Bet 3 ·", self.app_source)
        for label in ("Normal Bet", "Ante Bet", "Buy Feature"):
            self.assertIn(label, self.app_source)

    def test_loaded_player_details_rerender_after_language_change(self):
        self.assertIn("if (analyzedData.length) renderDashboard();", self.app_source)
        self.assertIn("const betTypeStr = getBetTypeLabel(row.bet_type, lang);", self.app_source)

    def test_loaded_status_messages_refresh_after_language_change(self):
        self.assertIn(
            "[singlePlayerStatus, monthlyStatus, gameStatus].forEach(refreshLocalizedStatus);",
            self.app_source,
        )
        for element_name in ("singlePlayerStatus", "monthlyStatus", "gameStatus"):
            with self.subTest(element_name=element_name):
                self.assertNotIn(f"{element_name}.textContent = translations[currentLang]", self.app_source)

    def test_agent_all_options_use_current_language(self):
        self.assertNotIn('<option value="ALL">ALL</option>', self.app_source)
        self.assertGreaterEqual(
            self.app_source.count("translations[currentLang].agentAll"),
            2,
        )

    def test_monthly_odd_rtp_trace_uses_translation(self):
        self.assertIn("name: lang.oddRtp", self.app_source)

    def test_single_player_lookup_copy_accepts_player_id(self):
        english = translation_entries(self.app_source, "en")
        chinese = translation_entries(self.app_source, "zh")
        self.assertIn("Player ID", english["singlePlayerName"])
        self.assertIn("Player ID", chinese["singlePlayerName"])


if __name__ == "__main__":
    unittest.main()
