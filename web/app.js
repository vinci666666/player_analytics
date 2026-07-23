import {
  escapeHtml,
  formatCount,
  formatCurrency,
  formatDateTimeForTooltip,
  formatDateTimeText,
  formatNullableCurrency,
  parseNullableNumber,
  setFormatterLocale
} from './js/formatters.js';
import {
  getCalendarMonthRange,
  getDefaultRangeStartDate,
  getPreviousCalendarMonthRange,
  isDateRangeOverOneYear,
  monthIndex,
  shiftMonth
} from './js/date-utils.js';
import { installAutoFitText } from './js/text-fit.js';

// iGaming 玩家投注行為分析儀表板前端邏輯 - 連接本地 PostgreSQL 後端

// 全域狀態變數
let analyzedData = [];      // 用於快取目前所選玩家在指定日期的所有旋轉紀錄
let currentLang = 'zh';     // 語系設定：預設為繁體中文 ('zh')，支援切換為英文 ('en')
const activeLocale = () => currentLang === 'zh' ? 'zh-TW' : 'en-US';
let currentPlayersRequestController = null;
let currentDataRequestController = null;
let currentPlayerGamesRequestController = null;
let monthlyDataCache = [];
let latestAvailableMonth = '';
let monthlyLatestAvailableDate = '';
let lastLoadedMonthlyMonth = '';
let gameDataCache = [];
let gameHourlyPlayersCache = [];
let gameComparisonDataCache = [];
let gameComparisonSlotCache = '';
let monthlyGameRankingCache = [];
let monthlyGameRankingRange = { startDate: '', endDate: '' };
let monthlyRankingSort = { key: 'total_spin_count', direction: 'desc' };
let gameSpinDistributionCache = [];
let gameRankingCache = [];
let gameRankingSort = { key: 'total_spin_count', direction: 'desc' };
let gameDetailSort = { key: 'date', direction: 'asc' };
let agentDetailSort = { key: 'date', direction: 'desc' };
let agentGameDetailSort = { key: 'date', direction: 'asc' };
let gameRankingRequestId = 0;
let gameLatestAvailableDate = '';
let lastLoadedGameSingleDate = '';
let homeDashboardCache = null;
let agentOptionRows = [];
let agentInitialized = false;
let agentAnalysisCache = null;
let agentGamePerformanceCache = null;
let agentGamePerformanceRequestId = 0;
const UI_STATE_KEY = 'playerAnalytics.uiState.v1';
let restoredUiState = null;
let pendingGameSlot = '';
let pendingPlayerId = '';
let pendingPlayerGame = 'ALL';
let navigationToastTimer = null;
let singlePlayerContext = null;
let chartRenderFrame = null;
let homeRefreshTimer = null;
let homeDashboardRequest = null;
let homeDashboardLoadedAt = 0;
const HOME_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_CHART_POINTS = 4000;

installAutoFitText('.metric-value', { minSize: 10 });

function readUiState() {
  try {
    return JSON.parse(localStorage.getItem(UI_STATE_KEY) || 'null');
  } catch (error) {
    console.warn('Unable to restore UI state:', error);
    return null;
  }
}

function saveUiState() {
  try {
    const activePage = document.querySelector('.page-nav-item.active')?.dataset.page || 'player';
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({
      activePage,
      lang: currentLang,
      monthly: {
        mode: monthlyModeSelect.value,
        month: monthlyMonthSelect.value,
        startMonth: monthlyStartMonth.value,
        endMonth: monthlyEndMonth.value
      },
      game: {
        dateMode: gameDateModeSelect.value,
        singleDate: gameSingleDate.value,
        startDate: gameStartDate.value,
        endDate: gameEndDate.value,
        slot: gameSlotSelect.value || pendingGameSlot || 'ALL'
      },
      agent: {
        parentAgentId: agentParentSelect.value,
        agentId: agentSelect.value,
        game: agentGameSelect.value,
        startDate: agentStartDate.value,
        endDate: agentEndDate.value
      },
      player: {
        dateMode: dateModeSelect.value,
        date: dateSelect.value,
        startDate: dateStartSelect.value,
        endDate: dateEndSelect.value,
        minSpins: minSpinsInput.value,
        maxSpins: maxSpinsInput.value,
        game: playerGameSelect.value,
        playerId: playerSelect.value,
        newPlayer: checkboxNewPlayer.checked,
        oldPlayer: checkboxOldPlayer.checked,
        winPlayer: checkboxWinPlayer.checked,
        losePlayer: checkboxLosePlayer.checked
      }
    }));
  } catch (error) {
    console.warn('Unable to save UI state:', error);
  }
}

// DOM 元素參考
const dateModeSelect = document.getElementById('date-mode-select');
const containerSingleDate = document.getElementById('container-single-date');
const containerRangeDate = document.getElementById('container-range-date');
const dateSelect = document.getElementById('date-select');
const dateStartSelect = document.getElementById('date-start-select');
const dateEndSelect = document.getElementById('date-end-select');
const minSpinsInput = document.getElementById('input-min-spins');
const maxSpinsInput = document.getElementById('input-max-spins');
const playerGameSelect = document.getElementById('player-game-select');
const playerSelect = document.getElementById('player-select');
const btnOpenSinglePlayer = document.getElementById('btn-open-single-player');
const btnLangToggle = document.getElementById('btn-lang-toggle');
const btnApplyFilters = document.getElementById('btn-apply-filters');
const checkboxNewPlayer = document.getElementById('checkbox-new-player');
const checkboxOldPlayer = document.getElementById('checkbox-old-player');
const checkboxWinPlayer = document.getElementById('checkbox-win-player');
const checkboxLosePlayer = document.getElementById('checkbox-lose-player');
const pageNavItems = document.querySelectorAll('.page-nav-item');
const monthlyContent = document.getElementById('monthly-analysis-content');
const homeContent = document.getElementById('home-analysis-content');
const homeStatus = document.getElementById('home-status');
const monthlyModeSelect = document.getElementById('monthly-mode-select');
const monthlyMonthSelect = document.getElementById('monthly-month-select');
const monthlySingleControls = document.getElementById('monthly-single-controls');
const btnMonthlyPrevious = document.getElementById('btn-monthly-previous');
const btnMonthlyNext = document.getElementById('btn-monthly-next');
const monthlyCompareControls = document.getElementById('monthly-compare-controls');
const monthlyStartMonth = document.getElementById('monthly-start-month');
const monthlyEndMonth = document.getElementById('monthly-end-month');
const monthlyBetTypePanel = document.getElementById('monthly-bet-type-panel');
const monthlyDnuPanel = document.getElementById('monthly-dnu-panel');
const monthlyRetention3Panel = document.getElementById('monthly-retention-3-panel');
const monthlyRetention7Panel = document.getElementById('monthly-retention-7-panel');
const btnLoadMonthly = document.getElementById('btn-load-monthly');
const monthlyStatus = document.getElementById('monthly-status');
const gameContent = document.getElementById('game-analysis-content');
const gameSlotSelect = document.getElementById('game-slot-select');
const gameCompareToggleControl = document.getElementById('game-compare-toggle-control');
const gameCompareCheckbox = document.getElementById('game-compare-checkbox');
const gameCompareSelectControl = document.getElementById('game-compare-select-control');
const gameCompareSlotSelect = document.getElementById('game-compare-slot-select');
const gameDateModeSelect = document.getElementById('game-date-mode-select');
const gameSingleDateControls = document.getElementById('game-single-date-controls');
const gameSingleDate = document.getElementById('game-single-date');
const btnGamePreviousDay = document.getElementById('btn-game-previous-day');
const btnGameNextDay = document.getElementById('btn-game-next-day');
const gameCustomDateControls = document.getElementById('game-custom-date-controls');
const gameStartDate = document.getElementById('game-start-date');
const gameEndDate = document.getElementById('game-end-date');
const btnLoadGame = document.getElementById('btn-load-game');
const gameStatus = document.getElementById('game-status');
const gameSpinDistributionPanel = document.getElementById('game-spin-distribution-panel');
const gameCompareSpinDistributionPanel = document.getElementById('game-compare-spin-distribution-panel');
const gameDauDnuPanel = document.getElementById('game-dau-dnu-panel');
const gameRtpPanel = document.getElementById('game-rtp-panel');
const gameRetentionPanel = document.getElementById('game-retention-panel');
const gameDailyBetPanel = document.getElementById('game-daily-bet-panel');
const gameDailyBetBody = document.getElementById('game-daily-bet-body');
const gameRankingPanel = document.getElementById('game-ranking-panel');
const agentContent = document.getElementById('agent-analysis-content');
const agentParentSelect = document.getElementById('agent-parent-select');
const agentSelect = document.getElementById('agent-select');
const agentGameSelect = document.getElementById('agent-game-select');
const agentGameLabel = document.getElementById('agent-label-game');
const agentLabelAgent = document.getElementById('agent-label-agent');
const agentStartDate = document.getElementById('agent-start-date');
const agentEndDate = document.getElementById('agent-end-date');
const btnLoadAgent = document.getElementById('btn-load-agent');
const agentStatus = document.getElementById('agent-status');
const singlePlayerContent = document.getElementById('single-player-analysis-content');
const singlePlayerForm = document.getElementById('single-player-form');
const singlePlayerName = document.getElementById('single-player-name');
const singlePlayerStartDate = document.getElementById('single-player-start-date');
const singlePlayerEndDate = document.getElementById('single-player-end-date');
const singlePlayerSubmit = document.getElementById('btn-load-single-player');
const singlePlayerStatus = document.getElementById('single-player-status');
const globalDataLoading = document.getElementById('global-data-loading');
const globalDataLoadingMessage = document.getElementById('global-data-loading-message');
const navigationToast = document.getElementById('navigation-toast');
const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginSubmit = document.getElementById('login-submit');
const loginError = document.getElementById('login-error');
const btnLogout = document.getElementById('btn-logout');
const originalFetch = window.fetch.bind(window);
let dashboardInitialized = false;
let activeDataRequestCount = 0;

pageNavItems.forEach((item) => {
  item.addEventListener('click', (event) => {
    const page = item.dataset.page;
    if (page === 'home' || page === 'monthly' || page === 'game' || page === 'agent' || page === 'single-player') {
      event.preventDefault();
      setActivePage(page);
    } else if (page === 'player') {
      event.preventDefault();
      setActivePage('player');
    } else {
      event.preventDefault();
    }
  });
});

// 指標數據顯示元素參考
const metricStatsSpins = document.getElementById('metric-stats-spins');
const metricStatsTotalWager = document.getElementById('metric-stats-total-wager');
const metricStatsTotalPayout = document.getElementById('metric-stats-total-payout');
const metricStatsNetProfit = document.getElementById('metric-stats-net-profit');
const metricStatsFirstSpin = document.getElementById('metric-stats-first-spin');
const metricStatsLastUpdate = document.getElementById('metric-stats-last-update');
const metricTotalSpins = document.getElementById('metric-total-spins');
const metricTotalWager = document.getElementById('metric-total-wager');
const metricTotalPayout = document.getElementById('metric-total-payout');
const metricNetProfit = document.getElementById('metric-net-profit');
const metricGameSwitches = document.getElementById('metric-game-switches');
const metricFreeGames = document.getElementById('metric-free-games');

// 數據明細表格本體
const tableBody = document.getElementById('table-body');
const gameWagerSummaryBody = document.getElementById('game-wager-summary-body');

// ----------------------------------------------------
// 本地語系化字典 (i18n)
// ----------------------------------------------------
const translations = {
  en: {
    title: "iGaming Operations Analytics",
    subtitle: "// Player & Game Performance Platform",
    legendCurve: "Cumulative Profit Curve",
    legendFg: "Free Game Marker",
    legendGs: "Game Switch Marker",
    filterTitle: "Player Analysis Filters",
    labelActivePlayer: "Player ID",
    labelPlayerGame: "Game",
    playerGamesLoadFailed: "Game list failed to load; please reload the page.",
    labelActiveDate: "Analysis Date",
    labelFiltersTitle: "Player Segments",
    labelNewPlayer: "New Player",
    labelOldPlayer: "Old Player",
    labelWinPlayer: "Winning Player",
    labelLosePlayer: "Losing Player (Incl. Tie)",
    placeholderPlayer: "(Select date first)",
    placeholderDate: "(Loading dates...)",
    labelDateMode: "Date Filter Mode",
    placeholderSelectPlayer: "(Select player ID)",
    optDateModeSingle: "Single Day",
    optDateModeRange: "Date Range",
    labelStartDate: "Start Date",
    labelEndDate: "End Date",
    labelMinSpins: "Minimum Spins",
    labelMaxSpins: "Maximum Spins",
    labelApplyFilters: "Apply Filters",
    placeholderApplyFilters: "(Click Apply Filters to load players)",
    placeholderLoadingPlayers: "(Loading players...)",
    filterTimeoutMessage: "Request timed out after 30 seconds. Please apply filters again.",
    schemaTitle: "Target Schema Spec",
    schemaDesc: "Target table is <code>public.slot_parent_bet</code> with the fields:",
    metricsPlayerTitle: "Player Lifetime Summary",
    metricsRangeTitle: "Selected-Period Summary",
    statTotalSpins: "Total Spins",
    statTotalWager: "Total Wagered (IDR)",
    statTotalPayout: "Total Payouts (IDR)",
    statTotalNet: "Player Net Result (IDR)",
    statFirstSpin: "First Spin Date",
    statLastUpdate: "Last Update Time",
    statSpins: "Range Spins",
    statWager: "Range Wagered (IDR)",
    statPayout: "Range Payouts (IDR)",
    statNet: "Period Net Result (IDR)",
    statSwitches: "Game Switches",
    statFree: "Free Game Spins",
    tabTable: "📊 Betting Sequence Details",
    gameWagerSummaryTitle: "Game Wager Records",
    gameWagerGame: "Game",
    gameName: "Game Name",
    gameWagerType: "Wager Type",
    thSeq: "Sequence",
    thPlayer: "Player ID",
    thTime: "Timestamp (bet_at_utc7)",
    thSlot: "Game Name",
    thBetType: "Wager Type",
    betTypeNormal: "Normal Bet",
    betTypeAnte: "Ante Bet",
    betTypeBuy: "Buy Feature",
    betTypeUnknown: "Unknown",
    thSwitch: "Game Changed",
    thFree: "Free Spin",
    thBet: "Wager (IDR)",
    thPrize: "Payout (IDR)",
    thNet: "Player Net Result (IDR)",
    thCum: "Daily Cumulative Result (IDR)",
    tdEmpty: "Select an analysis date and player ID from the filters above.",
    badgeChanged: "🔄 Changed",
    badgeFree: "⭐ Free",
    btnCopySql: "Copy SQL",
    btnCopyPython: "Copy Python",
    // 圖表專用欄位
    chartTitle: "Player {player} Cumulative Profit Curve - {date}",
    chartXAxis: "Play Sequence Number (play_seq)",
    chartYAxis: "Cumulative Profit (IDR)",
    chartLegendProfit: "Cumulative Daily Profit",
    chartLegendBet: "Wager Amount",
    chartLegendFg: "Free Game Feature",
    chartLegendGs: "Game Switch",
    tooltipSeq: "Play Sequence",
    tooltipTime: "Time",
    tooltipSlot: "Game",
    tooltipCumProfit: "Cumulative Profit",
    tooltipNetProfit: "Spin Net Profit",
    tooltipBet: "Bet",
    tooltipPrize: "Prize",
    tooltipFreeGame: "⭐ Free Game Spin",
    tooltipSwitch: "🔄 Switched Slot Game",
    tooltipNewGame: "New Game",
    tooltipCumShort: "Cum. Profit",
    navTitle: "Operations Analytics",
    navEyebrow: "ANALYTICS",
    monthlyEyebrow: "MONTHLY OPERATIONS",
    gameEyebrow: "GAME PERFORMANCE",
    agentEyebrow: "AGENT ANALYSIS",
    navSinglePlayer: "Single Player Analysis",
    navHome: "Operations Overview",
    navMonthly: "Monthly Operations",
    navGame: "Game Performance",
    navAgent: "Agent Analysis",
    navPlayer: "Player Behavior",
    singlePlayerEyebrow: "PLAYER LOOKUP",
    singlePlayerTitle: "Single Player Analysis",
    singlePlayerDescription: "Enter a player name or Player ID and date range to view betting trends and individual wager details.",
    singlePlayerName: "Player Name / Player ID",
    singlePlayerNamePlaceholder: "Enter a player name or Player ID",
    singlePlayerStart: "Start Date",
    singlePlayerEnd: "End Date",
    singlePlayerSubmit: "Analyze Player",
    singlePlayerLoading: "Loading player betting records…",
    singlePlayerQuerying: "Querying…",
    singlePlayerLoaded: "Loaded {count} wagers for {name} from {start} to {end}.",
    singlePlayerNoData: "No wagers were found for this player in the selected period.",
    singlePlayerNameRequired: "Enter a player name or Player ID.",
    homeEyebrow: "OPERATIONS OVERVIEW",
    homeTitle: "Operations Overview",
    homeDescription: "Monitor operating performance, game rankings, and high-profit player alerts",
    homeDataDate: "Data as of: {date}",
    homeMonthTitle: "Month-to-Date Performance",
    homeMonthRangeComparison: "{currentStart}–{currentEnd} vs. {previousStart}–{previousEnd}",
    homeDayTitle: "Current-Day Performance",
    homeGameRankingTitle: "Game Performance Rankings",
    homeAgentPerformanceTitle: "Agent Performance",
    homeAgentSevenDayTop10: "Last 7 Days · Top 10",
    homeAgentCurrentDayTop10: "Current Day · Top 10",
    homePlayerAlertTitle: "High-Profit Player Alerts",
    homeSevenDayTop10: "Last 7 Days · Top 10",
    homeCurrentDayTop5: "Current Day · Top 5",
    homeComparedPrevious: "vs. previous month {value}%",
    homeGgr30d: "30-Day GGR & DAU Trend",
    homeHourlySpins: "Hourly Spins · Latest 24 Hours",
    homeProfit: "Player Profit",
    homeLoading: "Loading operations overview…",
    homeLoadError: "Failed to load operations overview: {message}",
    monthlyTitle: "Monthly Operations Analysis",
    monthlyDescription: "Operating KPIs, retention, and game performance trends",
    gameTitle: "Game Performance Analysis",
    gameDescription: "Daily engagement, monetization, and retention by game",
    agentTitle: "Agent Analysis",
    agentDescription: "Daily performance by agent hierarchy, wager type, and date range",
    labelAnalysisMonth: "Analysis Month",
    labelPeriodEndMonth: "End Month",
    labelMonthlyMode: "Analysis Mode",
    monthlyModeSingle: "Single Month",
    monthlyModeCompare: "Compare Months",
    monthlyModeQuarter: "Quarter Analysis",
    monthlyModeHalfYear: "Half-Year Analysis",
    monthlyModeYear: "Year Analysis",
    previousMonth: "Previous Month",
    nextMonth: "Next Month",
    labelStartMonth: "Start Month",
    labelEndMonth: "End Month",
    monthlyRangeOrderError: "Start month must be before or equal to end month.",
    monthlyRangeLimitError: "Month comparison is limited to 6 months.",
    labelGame: "Game",
    compareGames: "Compare another game",
    labelCompareGame: "Comparison game",
    labelGameDateMode: "Date Range",
    gameDateToday: "Today",
    gameDateYesterday: "Yesterday",
    gameDateSingleDay: "Select One Day",
    gameDateSevenDays: "Last 7 Days (including today)",
    gameDateCustom: "Custom Range",
    previousDay: "Previous Day",
    nextDay: "Next Day",
    labelGameSingleDate: "Analysis Date",
    allGames: "All Games",
    loadMonthly: "Run Monthly Analysis",
    loadGame: "Run Game Analysis",
    avgPlayers: "Avg. Active Players (DAU)",
    avgDnu: "Avg. New Players (DNU)",
    avgRtp: "Avg. RTP",
    totalSpinsLabel: "Total Spins",
    totalBet: "Total Wager Amount",
    totalWin: "Total Payout Amount",
    totalGgr: "Total GGR",
    dataDays: "Data Days",
    monthlyLoading: "Loading monthly analysis…",
    monthlyNoData: "No monthly analysis data for the selected dates.",
    monthlyMonthNoData: "No data is available for {month}. The previously selected month will be kept.",
    monthlyLoaded: "Loaded {days} days from {start} to {end}.",
    monthlyDateError: "Unable to load available dates. Please select dates manually.",
    monthlyLoadError: "Failed to load monthly analysis: {message}",
    gameLoading: "Loading game analysis…",
    gameNoData: "No game analysis data for the selected dates.",
    gameDayNoData: "No data is available for {date}. The previously selected date will be kept.",
    gameLoaded: "Loaded game data from {start} to {end}.",
    gameDateError: "Unable to load available dates. Please select dates manually.",
    gameLoadError: "Failed to load game analysis: {message}",
    gameMedianLoadError: "Median line could not be loaded: {message}. Restart the Flask server if it is still running old code.",
    agentLoading: "Loading agent analysis…",
    agentLoaded: "Agent analysis loaded.",
    agentNoData: "No agent data for the selected filters.",
    agentLoadError: "Failed to load agent analysis: {message}",
    gameOption: "{name}",
    unknownGame: "Unknown Game",
    chartDailyRtp: "Daily RTP Trend",
    chartDailyGgr: "Daily GGR Trend",
    chartDailyPlayers: "Daily Active Players (DAU)",
    chartDailyDnu: "Daily New Players (DNU)",
    chartDauDnu: "Daily Active & New Players (DAU / DNU)",
    chartDnuRate: "Daily DNU / DAU Rate",
    chartRetention: "Player Retention Trend",
    chartBetTypePlayers: "Players by Wager Type",
    chartGamePlayers: "Daily Active Players by Game",
    chartGameSpinShare: "Total Spin Share by Game",
    otherGames: "Other",
    chartGameSpinDistribution: "Daily Player Spin Distribution",
    chartMedianPlayerSpins: "Median Player Spins",
    chartGameGgr: "Daily Game GGR",
    chartGameGgrByGame: "Game GGR for the Day",
    chartGameDauDnu: "Daily Active & New Players by Game (DAU / DNU)",
    chartGameRtp: "Game RTP Trend",
    chartGameRetention: "Game Retention Trend",
    chartGameBetTypePlayers: "Game Bet Type Player Count",
    chartGameHourlyBetTypePlayers: "Hourly Players by Game Bet Type",
    chartGameHourlyBetTypePlayersAverage: "Average Hourly Players by Game Bet Type",
    gameDailyBetTitle: "Daily Bet Statistics for Selected Game",
    gameDailyBetDate: "Date",
    gameDailyBetType: "Bet Type",
    gameDailyBetPlayers: "Players",
    gameDailyBetSpins: "Spins",
    gameDailyBetAmount: "Wagered (IDR)",
    gameDailyWinAmount: "Payout (IDR)",
    gameDailyBetRtp: "RTP",
    gameDailyBetGgr: "GGR (IDR)",
    axisPlayers: "Players",
    axisRtp: "RTP (%)",
    oddRtp: "Odd RTP",
    axisRetention: "Retention (%)",
    axisGgr: "GGR (IDR)",
    axisDnuRate: "DNU / DAU (%)",
    gameRankingTitle: "Game Ranking in Selected Period",
    rankingGame: "Game Name",
    rankingDays: "Days",
    rankingPlayers: "Players",
    rankingAvgSpins: "Avg. Spins per Player",
    rankingAvgBet: "Avg. Wager (IDR)",
    rankingSpins: "Total Spins",
    rankingBet: "Total Wagered (IDR)",
    rankingWin: "Total Payout (IDR)",
    rankingGgr: "GGR (IDR)",
    rankingEmpty: "No game ranking data for this period.",
    serverError: "Server error",
    noDates: "No dates found in database",
    dateOrderError: "Start date must be before or equal to End date",
    rangeLimitError: "Time interval must be within one year",
    loading: "Loading...",
    globalDataLoading: "Searching for or loading data…",
    noPlayers: "(No players match filters)",
    playerOption: "Player ID: {player}",
    loadFailed: "Load failed: {message}",
    showingRecords: "Showing first 5,000 of {total} records. Please narrow down the date interval or adjust the spin range.",
    keyboardGameSwitch: "Switching game: {value}",
    keyboardPlayerSwitch: "Switching player: {value}",
    loginTitle: "iGaming Operations Analytics Platform",
    loginDescription: "Enter the access password to open the operations dashboard",
    loginPasswordLabel: "Access Password",
    loginSubmit: "Sign In",
    loginSubmitting: "Signing in…",
    loginInvalid: "Incorrect password. Please try again.",
    logout: "Sign Out",
    agentParent: "Parent Agent",
    agentLabel: "Agent",
    agentGame: "Game",
    agentAll: "All",
    agentAllGames: "All Games",
    agentLoad: "Run Agent Analysis",
    agentGameSummary: "Game Summary",
    agentDetails: "Daily Details",
    agentSortHint: "Sorted by Spins",
    agentPlayers: "Players",
    agentBet: "Total Wager",
    agentWin: "Total Payout",
    agentDailyBetTitle: "Daily Bet Statistics for Selected Game",
    username: "Username",
    notLoaded: "Data has not been loaded",
    apiRequestFailed: "The data request failed. Please try again.",
    pageNavigation: "Page navigation",
    date: "Date",
    selectGame: "Select {game}",
    drillDown: "Drill down to {entity}",
    allGameDetails: "Daily Game Details (click to select game)",
    gameDailyDetails: "{game} Daily Details",
    agentDailyDetails: "Daily Agent Details (click to drill down)",
    parentAgentDailyDetails: "Daily Parent Agent Details (click to drill down)",
    openGameAnalysis: "Open game performance analysis for {game}",
    openPlayerAnalysis: "Open individual analysis for {player}",
    homeAgentSevenDayShare: "7-Day Agent Spin Share",
    homeAgentCurrentDayShare: "Current-Day Agent Spin Share",
    other: "Other",
    parentAgentSpinShare: "Parent Agent Total Spin Share",
    parentAgentGgr: "GGR by Parent Agent",
    agentSpinShareTopFive: "Agent Total Spin Share (Top 5)",
    agentGgr: "GGR by Agent",
    dailyTotalSpins: "{context} Daily Total Spins",
    dailyGgr: "{context} Daily GGR",
    totalSpinsByGame: "Total Spins by Game",
    ggrByGame: "GGR by Game",
    dayOfMonth: "Day of Month",
    documentTitle: "iGaming Operations Analytics Platform",
    languageToggle: "EN / 繁中"
  },
  zh: {
    title: "iGaming 營運分析平台",
    subtitle: "// 玩家與遊戲績效分析",
    legendCurve: "累計利潤曲線",
    legendFg: "免費遊戲標記",
    legendGs: "切換遊戲標記",
    filterTitle: "玩家分析篩選條件",
    labelActivePlayer: "玩家 ID",
    labelPlayerGame: "遊戲",
    playerGamesLoadFailed: "遊戲清單載入失敗，請重新載入頁面。",
    labelActiveDate: "分析日期",
    labelFiltersTitle: "玩家分群",
    labelNewPlayer: "新玩家",
    labelOldPlayer: "老玩家",
    labelWinPlayer: "贏錢玩家",
    labelLosePlayer: "輸錢玩家 (包含沒有輸贏)",
    placeholderPlayer: "(請先選擇日期)",
    placeholderDate: "(載入日期中...)",
    labelDateMode: "日期篩選模式",
    placeholderSelectPlayer: "(請選擇玩家 ID)",
    optDateModeSingle: "單日分析",
    optDateModeRange: "日期區間分析",
    labelStartDate: "開始日期",
    labelEndDate: "結束日期",
    labelMinSpins: "最低 Spin 數",
    labelMaxSpins: "最高 Spin 數",
    labelApplyFilters: "套用篩選",
    placeholderApplyFilters: "(請按篩選載入玩家)",
    placeholderLoadingPlayers: "(玩家載入中...)",
    filterTimeoutMessage: "本次請求已超過 30 秒並取消，請再次按篩選。",
    schemaTitle: "目標資料表 Schema",
    schemaDesc: "目標資料表為 <code>public.slot_parent_bet</code>，欄位如下：",
    metricsPlayerTitle: "玩家生命週期摘要",
    metricsRangeTitle: "所選期間績效摘要",
    statTotalSpins: "旋轉次數",
    statTotalWager: "總投注額 (IDR)",
    statTotalPayout: "總派彩額 (IDR)",
    statTotalNet: "玩家淨損益 (IDR)",
    statFirstSpin: "第一次 Spin 日期",
    statLastUpdate: "最後更新時間",
    statSpins: "範圍內旋轉次數",
    statWager: "範圍內總投注額 (IDR)",
    statPayout: "範圍內總派彩額 (IDR)",
    statNet: "期間玩家淨損益 (IDR)",
    statSwitches: "遊戲切換次數",
    statFree: "免費遊戲次數",
    tabTable: "📊 投注序列明細",
    gameWagerSummaryTitle: "遊戲投注紀錄",
    gameWagerGame: "遊戲",
    gameName: "遊戲名稱",
    gameWagerType: "投注方式",
    thSeq: "投注序號",
    thPlayer: "玩家 ID",
    thTime: "時間戳記 (bet_at_utc7)",
    thSlot: "遊戲名稱",
    thBetType: "投注方式",
    betTypeNormal: "一般投注",
    betTypeAnte: "加注投注",
    betTypeBuy: "購買功能",
    betTypeUnknown: "未知",
    thSwitch: "遊戲切換",
    thFree: "免費旋轉",
    thBet: "投注額 (IDR)",
    thPrize: "派彩額 (IDR)",
    thNet: "玩家淨損益 (IDR)",
    thCum: "每日累計損益 (IDR)",
    tdEmpty: "請由上方篩選條件選擇分析日期與玩家 ID。",
    badgeChanged: "🔄 已切換",
    badgeFree: "⭐ 免費",
    btnCopySql: "複製 SQL",
    btnCopyPython: "複製 Python",
    // 圖表專用欄位
    chartTitle: "玩家 {player} 累計利潤曲線 - {date}",
    chartXAxis: "投注序列號 (play_seq)",
    chartYAxis: "累計利潤 (IDR)",
    chartLegendProfit: "累計每日利潤",
    chartLegendBet: "每筆押注金額",
    chartLegendFg: "免費遊戲特色",
    chartLegendGs: "切換遊戲",
    tooltipSeq: "投注序列",
    tooltipTime: "時間",
    tooltipSlot: "遊戲",
    tooltipCumProfit: "累計利潤",
    tooltipNetProfit: "旋轉淨利",
    tooltipBet: "投注",
    tooltipPrize: "派彩",
    tooltipFreeGame: "⭐ 免費旋轉",
    tooltipSwitch: "🔄 切換老虎機遊戲",
    tooltipNewGame: "新遊戲",
    tooltipCumShort: "累計利潤",
    navTitle: "營運分析中心",
    navEyebrow: "數據分析",
    monthlyEyebrow: "月度營運",
    gameEyebrow: "遊戲績效",
    agentEyebrow: "AGENT 分析",
    navSinglePlayer: "單獨玩家分析",
    navHome: "營運總覽",
    navMonthly: "月度營運分析",
    navGame: "遊戲績效分析",
    navAgent: "Agent 分析",
    navPlayer: "玩家行為分析",
    singlePlayerEyebrow: "單一玩家查詢",
    singlePlayerTitle: "單獨玩家分析",
    singlePlayerDescription: "輸入玩家名稱或 Player ID 與時間範圍，查看押注趨勢與每筆押注明細。",
    singlePlayerName: "玩家名稱 / Player ID",
    singlePlayerNamePlaceholder: "輸入玩家名稱或 Player ID",
    singlePlayerStart: "開始日期",
    singlePlayerEnd: "結束日期",
    singlePlayerSubmit: "查詢玩家",
    singlePlayerLoading: "正在載入玩家押注紀錄…",
    singlePlayerQuerying: "查詢中…",
    singlePlayerLoaded: "已載入 {name} 於 {start} 至 {end} 的 {count} 筆押注。",
    singlePlayerNoData: "此玩家在所選期間沒有押注紀錄。",
    singlePlayerNameRequired: "請輸入玩家名稱或 Player ID。",
    homeEyebrow: "營運總覽",
    homeTitle: "營運總覽",
    homeDescription: "即時掌握營運績效、遊戲排行與高獲利玩家警示",
    homeDataDate: "資料基準日：{date}",
    homeMonthTitle: "本月累積績效",
    homeMonthRangeComparison: "{currentStart}–{currentEnd} 對比 {previousStart}–{previousEnd}",
    homeDayTitle: "當日累積績效",
    homeGameRankingTitle: "遊戲績效排名",
    homeAgentPerformanceTitle: "Agent 營運績效",
    homeAgentSevenDayTop10: "近 7 日 · Top 10",
    homeAgentCurrentDayTop10: "當日 · Top 10",
    homePlayerAlertTitle: "高獲利玩家警示",
    homeSevenDayTop10: "近 7 日 · Top 10",
    homeCurrentDayTop5: "當日 · Top 5",
    homeComparedPrevious: "較上月 {value}%",
    homeGgr30d: "近 30 日 GGR 與 DAU 趨勢",
    homeHourlySpins: "近 24 小時每小時 Spin 數",
    homeProfit: "玩家獲利",
    homeLoading: "正在載入營運總覽…",
    homeLoadError: "營運總覽載入失敗：{message}",
    monthlyTitle: "月度營運分析",
    monthlyDescription: "營運指標、玩家留存與遊戲績效趨勢",
    gameTitle: "遊戲績效分析",
    gameDescription: "依遊戲檢視每日參與度、營收與留存表現",
    agentTitle: "Agent 分析",
    agentDescription: "依代理層級、投注方式與日期檢視每日績效",
    labelAnalysisMonth: "分析月份",
    labelPeriodEndMonth: "結束月份",
    labelMonthlyMode: "分析模式",
    monthlyModeSingle: "單月資料",
    monthlyModeCompare: "月比較",
    monthlyModeQuarter: "季分析",
    monthlyModeHalfYear: "半年分析",
    monthlyModeYear: "年分析",
    previousMonth: "前一個月",
    nextMonth: "下一個月",
    labelStartMonth: "開始月份",
    labelEndMonth: "結束月份",
    monthlyRangeOrderError: "開始月份必須早於或等於結束月份。",
    monthlyRangeLimitError: "月比較區間最多為 6 個月。",
    labelGame: "遊戲",
    compareGames: "比較其他遊戲",
    labelCompareGame: "比較遊戲",
    labelGameDateMode: "時間範圍",
    gameDateToday: "今日",
    gameDateYesterday: "昨日",
    gameDateSingleDay: "指定單日",
    gameDateSevenDays: "近 7 日（包含今日）",
    gameDateCustom: "任意範圍",
    previousDay: "前一日",
    nextDay: "後一日",
    labelGameSingleDate: "分析日期",
    allGames: "全部遊戲",
    loadMonthly: "執行月度分析",
    loadGame: "執行遊戲分析",
    avgPlayers: "日均活躍玩家 (DAU)",
    avgDnu: "日均新增玩家 (DNU)",
    avgRtp: "平均 RTP",
    totalSpinsLabel: "總 Spin 數",
    totalBet: "總投注額",
    totalWin: "總派彩額",
    totalGgr: "總 GGR",
    dataDays: "資料天數",
    monthlyLoading: "正在載入月度營運資料…",
    monthlyNoData: "所選期間沒有月度營運資料。",
    monthlyMonthNoData: "{month} 沒有資料，將保留原本選擇的月份。",
    monthlyLoaded: "已載入 {start} 至 {end} 的 {days} 天資料。",
    monthlyDateError: "無法取得可用日期，請手動選擇日期。",
    monthlyLoadError: "月度營運分析載入失敗：{message}",
    gameLoading: "正在載入遊戲績效資料…",
    gameNoData: "所選期間沒有遊戲績效資料。",
    gameDayNoData: "{date} 沒有資料，將保留原本選擇的日期。",
    gameLoaded: "已載入 {start} 至 {end} 的遊戲資料。",
    gameDateError: "無法取得可用日期，請手動選擇日期。",
    gameLoadError: "遊戲績效分析載入失敗：{message}",
    gameMedianLoadError: "中位數折線載入失敗：{message}。若 Flask 尚未重啟，請先重新啟動伺服器。",
    agentLoading: "正在載入 Agent 分析…",
    agentLoaded: "Agent 分析已載入。",
    agentNoData: "所選條件沒有 Agent 資料。",
    agentLoadError: "Agent 分析載入失敗：{message}",
    gameOption: "{name}",
    unknownGame: "未知遊戲",
    chartDailyRtp: "每日 RTP 趨勢",
    chartDailyGgr: "每日營收 (GGR) 趨勢",
    chartDailyPlayers: "每日活躍玩家 (DAU)",
    chartDailyDnu: "每日新增玩家 (DNU)",
    chartDauDnu: "每日活躍與新增玩家 (DAU / DNU)",
    chartDnuRate: "每日 DNU / DAU 比例",
    chartRetention: "玩家留存率趨勢",
    chartBetTypePlayers: "各投注方式玩家數",
    chartGamePlayers: "遊戲每日活躍玩家趨勢",
    chartGameSpinShare: "所有遊戲 Total Spin 分布",
    otherGames: "其他",
    chartGameSpinDistribution: "每日玩家 Spin 量分布",
    chartMedianPlayerSpins: "玩家 Spin 中位數",
    chartGameGgr: "遊戲每日 GGR",
    chartGameGgrByGame: "當日各遊戲 GGR",
    chartGameDauDnu: "遊戲每日活躍與新增玩家（DAU / DNU）",
    chartGameRtp: "遊戲 RTP 趨勢",
    chartGameRetention: "遊戲 Retention 趨勢",
    chartGameBetTypePlayers: "遊戲 Bet Type 玩家數",
    chartGameHourlyBetTypePlayers: "遊戲 Bet Type 每小時玩家數",
    chartGameHourlyBetTypePlayersAverage: "遊戲 Bet Type 每小時平均玩家數",
    gameDailyBetTitle: "單一遊戲每日 Bet 統計",
    gameDailyBetDate: "日期",
    gameDailyBetType: "Bet 類型",
    gameDailyBetPlayers: "玩家數",
    gameDailyBetSpins: "Spin 數",
    gameDailyBetAmount: "投注額（IDR）",
    gameDailyWinAmount: "派彩額（IDR）",
    gameDailyBetRtp: "RTP",
    gameDailyBetGgr: "GGR（IDR）",
    axisPlayers: "玩家數",
    axisRtp: "RTP (%)",
    oddRtp: "特殊 RTP",
    axisRetention: "Retention (%)",
    axisGgr: "GGR (IDR)",
    axisDnuRate: "DNU / DAU (%)",
    gameRankingTitle: "時間範圍內遊戲排名",
    rankingGame: "遊戲名稱",
    rankingDays: "天數",
    rankingPlayers: "玩家數",
    rankingAvgSpins: "玩家平均 Spin 數",
    rankingAvgBet: "平均押注（IDR）",
    rankingSpins: "總 Spin 數",
    rankingBet: "總押注（IDR）",
    rankingWin: "總贏分（IDR）",
    rankingGgr: "GGR（IDR）",
    rankingEmpty: "此時間範圍沒有遊戲排名資料。",
    serverError: "伺服器錯誤",
    noDates: "資料庫中無日期資料",
    dateOrderError: "開始日期必須小於或等於結束日期",
    rangeLimitError: "時間區間不可超過一年",
    loading: "載入中...",
    globalDataLoading: "正在搜尋或載入資料…",
    noPlayers: "(此條件下查無玩家)",
    playerOption: "玩家 ID: {player}",
    loadFailed: "載入失敗：{message}",
    showingRecords: "僅顯示前 5,000 筆紀錄（共 {total} 筆）。請縮小時間區間或調整 Spin 範圍以精簡資料。",
    keyboardGameSwitch: "切換遊戲：{value}",
    keyboardPlayerSwitch: "切換玩家：{value}",
    loginTitle: "iGaming 營運分析平台",
    loginDescription: "請輸入存取密碼以進入營運儀表板",
    loginPasswordLabel: "存取密碼",
    loginSubmit: "登入平台",
    loginSubmitting: "登入中…",
    loginInvalid: "密碼錯誤，請重新輸入。",
    logout: "登出",
    agentParent: "上層 Agent",
    agentLabel: "Agent",
    agentGame: "遊戲",
    agentAll: "全部",
    agentAllGames: "全部遊戲",
    agentLoad: "執行 Agent 分析",
    agentGameSummary: "遊戲彙總",
    agentDetails: "每日明細",
    agentSortHint: "依 Spin 數排序",
    agentPlayers: "玩家數",
    agentBet: "總投注額",
    agentWin: "總派彩額",
    agentDailyBetTitle: "單一遊戲每日投注統計",
    username: "玩家名稱",
    notLoaded: "尚未載入資料",
    apiRequestFailed: "資料請求失敗，請稍後再試。",
    pageNavigation: "頁面導覽",
    date: "日期",
    selectGame: "選擇 {game}",
    drillDown: "下鑽至 {entity}",
    allGameDetails: "所有遊戲每日明細（點擊選擇遊戲）",
    gameDailyDetails: "{game} 每日明細",
    agentDailyDetails: "Agent 每日明細（點擊下鑽）",
    parentAgentDailyDetails: "上層 Agent 每日明細（點擊下鑽）",
    openGameAnalysis: "查看 {game} 的遊戲績效分析",
    openPlayerAnalysis: "查看 {player} 的單獨玩家分析",
    homeAgentSevenDayShare: "近 7 日 Agent Spin 占比",
    homeAgentCurrentDayShare: "當日 Agent Spin 占比",
    other: "其他",
    parentAgentSpinShare: "上層 Agent Total Spin 占比",
    parentAgentGgr: "各上層 Agent GGR",
    agentSpinShareTopFive: "Agent Total Spin 占比（前 5 名）",
    agentGgr: "各 Agent GGR",
    dailyTotalSpins: "{context} 每日 Total Spin",
    dailyGgr: "{context} 每日 GGR",
    totalSpinsByGame: "所有遊戲 Total Spin",
    ggrByGame: "所有遊戲 GGR",
    dayOfMonth: "日期（日）",
    documentTitle: "iGaming 營運分析平台",
    languageToggle: "繁中 / EN"
  }
};

const localizedStatusStates = new WeakMap();

function refreshLocalizedStatus(element) {
  const state = localizedStatusStates.get(element);
  if (!state) return;
  let message = translations[currentLang][state.key] || '';
  Object.entries(state.replacements).forEach(([key, value]) => {
    message = message.replace(`{${key}}`, value);
  });
  element.textContent = message;
}

function setLocalizedStatus(element, key, replacements = {}) {
  if (!key) {
    localizedStatusStates.delete(element);
    element.textContent = '';
    return;
  }
  localizedStatusStates.set(element, { key, replacements });
  refreshLocalizedStatus(element);
}

function updateLanguageUI() {
  // 依據當前語系設定更新網頁上的所有文字欄位
  const lang = translations[currentLang];
  const locale = activeLocale();
  document.documentElement.lang = currentLang === 'zh' ? 'zh-Hant' : 'en';
  setFormatterLocale(locale);
  document.querySelector('.page-navigation')?.setAttribute('aria-label', lang.pageNavigation);
  globalDataLoadingMessage.textContent = lang.globalDataLoading;
  document.title = lang.documentTitle;
  document.getElementById('login-title').textContent = lang.loginTitle;
  document.getElementById('login-description').textContent = lang.loginDescription;
  document.getElementById('login-password-label').textContent = lang.loginPasswordLabel;
  if (!loginSubmit.disabled) loginSubmit.textContent = lang.loginSubmit;
  btnLogout.textContent = lang.logout;
  
  // 頁首 Header 區塊
  document.getElementById('nav-title').childNodes[0].textContent = lang.title + ' ';
  document.getElementById('nav-subtitle').textContent = lang.subtitle;
  btnLangToggle.textContent = lang.languageToggle;

  document.getElementById('page-nav-title').textContent = lang.navTitle;
  document.getElementById('page-nav-eyebrow').textContent = lang.navEyebrow;
  document.getElementById('page-nav-home').textContent = lang.navHome;
  document.getElementById('page-nav-monthly').textContent = lang.navMonthly;
  document.getElementById('page-nav-game').textContent = lang.navGame;
  document.getElementById('page-nav-agent').textContent = lang.navAgent;
  document.getElementById('page-nav-single-player').textContent = lang.navSinglePlayer;
  document.getElementById('page-nav-player').textContent = lang.navPlayer;
  document.getElementById('single-player-eyebrow').textContent = lang.singlePlayerEyebrow;
  document.getElementById('single-player-page-title').textContent = lang.singlePlayerTitle;
  document.getElementById('single-player-page-description').textContent = lang.singlePlayerDescription;
  document.getElementById('single-player-name-label').textContent = lang.singlePlayerName;
  singlePlayerName.placeholder = lang.singlePlayerNamePlaceholder;
  document.getElementById('single-player-start-label').textContent = lang.singlePlayerStart;
  document.getElementById('single-player-end-label').textContent = lang.singlePlayerEnd;
  singlePlayerSubmit.textContent = singlePlayerSubmit.disabled ? lang.singlePlayerQuerying : lang.singlePlayerSubmit;
  [singlePlayerStatus, monthlyStatus, gameStatus].forEach(refreshLocalizedStatus);

  document.getElementById('home-eyebrow').textContent = lang.homeEyebrow;
  document.getElementById('home-page-title').textContent = lang.homeTitle;
  document.getElementById('home-page-description').textContent = lang.homeDescription;
  document.getElementById('home-month-title').textContent = lang.homeMonthTitle;
  document.getElementById('home-day-title').textContent = lang.homeDayTitle;
  document.getElementById('home-game-ranking-title').textContent = lang.homeGameRankingTitle;
  document.getElementById('home-agent-performance-title').textContent = lang.homeAgentPerformanceTitle;
  document.getElementById('home-agent-7d-title').textContent = lang.homeAgentSevenDayTop10;
  document.getElementById('home-agent-day-title').textContent = lang.homeAgentCurrentDayTop10;
  document.getElementById('home-player-alert-title').textContent = lang.homePlayerAlertTitle;
  ['home-game-7d-title', 'home-player-7d-title'].forEach(id => document.getElementById(id).textContent = lang.homeSevenDayTop10);
  ['home-game-day-title', 'home-player-day-title'].forEach(id => document.getElementById(id).textContent = lang.homeCurrentDayTop5);
  ['home-month-spins-label', 'home-day-spins-label'].forEach(id => document.getElementById(id).textContent = lang.totalSpinsLabel);
  ['home-month-bet-label', 'home-day-bet-label'].forEach(id => document.getElementById(id).textContent = lang.totalBet);
  ['home-month-win-label', 'home-day-win-label'].forEach(id => document.getElementById(id).textContent = lang.totalWin);
  ['home-game-7d-name', 'home-game-day-name'].forEach(id => document.getElementById(id).textContent = lang.rankingGame);
  ['home-game-7d-body', 'home-game-day-body'].forEach(bodyId => {
    const headers = document.getElementById(bodyId).closest('table').querySelectorAll('th');
    headers[1].textContent = lang.totalSpinsLabel;
    headers[2].textContent = 'GGR (IDR)';
  });
  ['home-player-7d-body', 'home-player-day-body'].forEach(bodyId => {
    const headers = document.getElementById(bodyId).closest('table').querySelectorAll('th');
    [lang.username, lang.totalSpinsLabel, `${lang.totalBet} (IDR)`, `${lang.totalWin} (IDR)`, `${lang.homeProfit} (IDR)`]
      .forEach((label, index) => headers[index].textContent = label);
  });

  document.getElementById('monthly-page-title').textContent = lang.monthlyTitle;
  document.getElementById('monthly-eyebrow').textContent = lang.monthlyEyebrow;
  document.getElementById('monthly-page-description').textContent = lang.monthlyDescription;
  document.getElementById('monthly-label-mode').textContent = lang.labelMonthlyMode;
  document.getElementById('monthly-mode-single-option').textContent = lang.monthlyModeSingle;
  document.getElementById('monthly-mode-compare-option').textContent = lang.monthlyModeCompare;
  document.getElementById('monthly-mode-quarter-option').textContent = lang.monthlyModeQuarter;
  document.getElementById('monthly-mode-half-year-option').textContent = lang.monthlyModeHalfYear;
  document.getElementById('monthly-mode-year-option').textContent = lang.monthlyModeYear;
  btnMonthlyPrevious.textContent = lang.previousMonth;
  btnMonthlyNext.textContent = lang.nextMonth;
  document.getElementById('monthly-label-month').textContent = ['quarter', 'half-year', 'year'].includes(monthlyModeSelect.value)
    ? lang.labelPeriodEndMonth : lang.labelAnalysisMonth;
  document.getElementById('monthly-label-start-month').textContent = lang.labelStartMonth;
  document.getElementById('monthly-label-end-month').textContent = lang.labelEndMonth;
  btnLoadMonthly.textContent = lang.loadMonthly;
  document.getElementById('monthly-label-avg-players').textContent = lang.avgPlayers;
  document.getElementById('monthly-label-avg-dnu').textContent = lang.avgDnu;
  document.getElementById('monthly-label-avg-rtp').textContent = lang.avgRtp;
  document.getElementById('monthly-label-total-spins').textContent = lang.totalSpinsLabel;
  document.getElementById('monthly-label-total-bet').textContent = lang.totalBet;
  document.getElementById('monthly-label-total-win').textContent = lang.totalWin;
  document.getElementById('monthly-label-total-ggr').textContent = lang.totalGgr;
  document.getElementById('monthly-label-days').textContent = lang.dataDays;
  document.getElementById('monthly-game-ranking-title').textContent = lang.gameRankingTitle;
  document.getElementById('game-ranking-title').textContent = lang.gameRankingTitle;
  const rankingLabels = {
    game_name: lang.rankingGame, days: lang.rankingDays, player_count: lang.rankingPlayers,
    avg_spin_count: lang.rankingAvgSpins, avg_bet_amount: lang.rankingAvgBet,
    total_spin_count: lang.rankingSpins, total_bet_amount: lang.rankingBet,
    total_win_amount: lang.rankingWin, ggr: lang.rankingGgr
  };
  document.querySelectorAll('[data-ranking-key]').forEach(button => {
    button.dataset.label = rankingLabels[button.dataset.rankingKey];
    button.textContent = rankingLabels[button.dataset.rankingKey];
  });
  document.querySelectorAll('[data-game-ranking-key]').forEach(button => {
    button.dataset.label = rankingLabels[button.dataset.gameRankingKey];
    button.textContent = rankingLabels[button.dataset.gameRankingKey];
  });

  document.getElementById('game-page-title').textContent = lang.gameTitle;
  document.getElementById('game-eyebrow').textContent = lang.gameEyebrow;
  document.getElementById('game-page-description').textContent = lang.gameDescription;
  document.getElementById('agent-page-title').textContent = lang.agentTitle;
  document.getElementById('agent-eyebrow').textContent = lang.agentEyebrow;
  document.getElementById('agent-page-description').textContent = lang.agentDescription;
  document.getElementById('agent-label-parent').textContent = lang.agentParent;
  document.getElementById('agent-label-agent').textContent = lang.agentLabel;
  document.getElementById('agent-label-game').textContent = lang.agentGame;
  document.getElementById('agent-label-start-date').textContent = lang.labelStartDate;
  document.getElementById('agent-label-end-date').textContent = lang.labelEndDate;
  document.getElementById('btn-load-agent').textContent = lang.agentLoad;
  document.getElementById('agent-game-summary-title').textContent = lang.agentGameSummary;
  document.getElementById('agent-details-title').textContent = lang.agentDetails;
  document.getElementById('home-agent-sort-hint').textContent = lang.agentSortHint;
  document.getElementById('agent-game-daily-bet-title').textContent = lang.agentDailyBetTitle;
  ['agent-parent-select', 'agent-select'].forEach(id => {
    const all = document.querySelector(`#${id} option[value="ALL"]`);
    if (all) all.textContent = lang.agentAll;
  });
  const allAgentGames = document.querySelector('#agent-game-select option[value="ALL"]');
  if (allAgentGames) allAgentGames.textContent = lang.agentAllGames;
  const agentMetricLabels = [lang.avgPlayers, lang.avgDnu, lang.avgRtp, lang.totalSpinsLabel,
    `${lang.totalBet} · IDR`, `${lang.totalWin} · IDR`, `${lang.totalGgr} · IDR`, lang.dataDays];
  document.querySelectorAll('#agent-game-performance .monthly-metrics-grid .metric-label')
    .forEach((element, index) => { element.textContent = agentMetricLabels[index]; });
  document.querySelectorAll('#agent-game-summary-panel thead th').forEach((element, index) => {
    element.textContent = [lang.agentGame, lang.totalSpinsLabel, lang.totalBet, lang.totalWin, 'GGR'][index];
  });
  document.querySelectorAll('#agent-game-daily-bet-panel thead button').forEach((element, index) => {
    element.textContent = [lang.gameDailyBetDate, lang.gameDailyBetType, lang.gameDailyBetPlayers,
      lang.gameDailyBetSpins, lang.gameDailyBetAmount, lang.gameDailyWinAmount,
      lang.gameDailyBetRtp, lang.gameDailyBetGgr][index];
    element.dataset.label = element.textContent;
  });
  document.querySelectorAll('#game-wager-summary-body').forEach(body => {
    body.closest('table').querySelectorAll('thead th').forEach((element, index) => {
      element.textContent = [lang.gameWagerGame, lang.gameWagerType, lang.totalSpinsLabel,
        lang.totalBet, lang.totalWin][index];
    });
  });
  const gameWagerEmpty = document.querySelector('#game-wager-summary-body .table-empty-message');
  if (gameWagerEmpty) gameWagerEmpty.textContent = lang.notLoaded;
  ['home-agent-7d-body', 'home-agent-day-body'].forEach(bodyId => {
    const headers = document.getElementById(bodyId).closest('table').querySelectorAll('th');
    [lang.agentParent, lang.agentLabel, lang.agentPlayers, lang.totalSpinsLabel,
      lang.agentBet, lang.agentWin, 'GGR'].forEach((label, index) => { headers[index].textContent = label; });
  });
  document.getElementById('game-label-slot').textContent = lang.labelGame;
  document.getElementById('game-compare-checkbox-label').textContent = lang.compareGames;
  document.getElementById('game-label-compare-slot').textContent = lang.labelCompareGame;
  document.getElementById('game-label-date-mode').textContent = lang.labelGameDateMode;
  document.getElementById('game-date-mode-today').textContent = lang.gameDateToday;
  document.getElementById('game-date-mode-yesterday').textContent = lang.gameDateYesterday;
  document.getElementById('game-date-mode-single-day').textContent = lang.gameDateSingleDay;
  document.getElementById('game-date-mode-seven-days').textContent = lang.gameDateSevenDays;
  document.getElementById('game-date-mode-custom').textContent = lang.gameDateCustom;
  btnGamePreviousDay.textContent = lang.previousDay;
  btnGameNextDay.textContent = lang.nextDay;
  document.getElementById('game-label-single-date').textContent = lang.labelGameSingleDate;
  document.getElementById('game-label-start-date').textContent = lang.labelStartDate;
  document.getElementById('game-label-end-date').textContent = lang.labelEndDate;
  btnLoadGame.textContent = lang.loadGame;
  document.getElementById('game-label-avg-players').textContent = lang.avgPlayers;
  document.getElementById('game-label-avg-dnu').textContent = lang.avgDnu;
  document.getElementById('game-label-avg-rtp').textContent = lang.avgRtp;
  document.getElementById('game-label-total-spins').textContent = lang.totalSpinsLabel;
  document.getElementById('game-label-total-bet').textContent = lang.totalBet;
  document.getElementById('game-label-total-win').textContent = lang.totalWin;
  document.getElementById('game-label-total-ggr').textContent = lang.totalGgr;
  document.getElementById('game-label-days').textContent = lang.dataDays;
  document.getElementById('game-daily-bet-title').textContent = lang.gameDailyBetTitle;
  document.getElementById('game-daily-bet-game').textContent = lang.gameName;
  document.getElementById('game-daily-bet-date').textContent = lang.gameDailyBetDate;
  document.getElementById('game-daily-bet-type').textContent = lang.gameDailyBetType;
  document.getElementById('game-daily-bet-players').textContent = lang.gameDailyBetPlayers;
  document.getElementById('game-daily-bet-spins').textContent = lang.gameDailyBetSpins;
  document.getElementById('game-daily-bet-amount').textContent = lang.gameDailyBetAmount;
  document.getElementById('game-daily-win-amount').textContent = lang.gameDailyWinAmount;
  document.getElementById('game-daily-bet-rtp').textContent = lang.gameDailyBetRtp;
  document.getElementById('game-daily-bet-ggr').textContent = lang.gameDailyBetGgr;
  document.querySelectorAll('[data-game-detail-key]').forEach(button => { button.dataset.label = button.textContent; });
  Array.from(gameSlotSelect.options).forEach(option => {
    option.textContent = option.value === 'ALL'
      ? lang.allGames
      : lang.gameOption.replace('{name}', formatGameNameOnly(option.value, option.dataset.gameName));
  });
  
  // 篩選器面板區塊
  document.getElementById('filter-title').textContent = lang.filterTitle;
  document.getElementById('label-active-player').textContent = lang.labelActivePlayer;
  document.getElementById('label-player-game').textContent = lang.labelPlayerGame;
  document.getElementById('label-open-single-player').textContent = lang.singlePlayerTitle;
  document.getElementById('label-active-date').textContent = lang.labelActiveDate;
  document.getElementById('label-filters-title').textContent = lang.labelFiltersTitle;
  document.getElementById('label-new-player').textContent = lang.labelNewPlayer;
  document.getElementById('label-old-player').textContent = lang.labelOldPlayer;
  document.getElementById('label-win-player').textContent = lang.labelWinPlayer;
  document.getElementById('label-lose-player').textContent = lang.labelLosePlayer;
  
  // 新篩選器元素
  document.getElementById('label-date-mode').textContent = lang.labelDateMode;
  document.getElementById('opt-date-mode-single').textContent = lang.optDateModeSingle;
  document.getElementById('opt-date-mode-range').textContent = lang.optDateModeRange;
  document.getElementById('label-start-date').textContent = lang.labelStartDate;
  document.getElementById('label-end-date').textContent = lang.labelEndDate;
  document.getElementById('label-min-spins').textContent = lang.labelMinSpins;
  document.getElementById('label-max-spins').textContent = lang.labelMaxSpins;
  document.getElementById('label-apply-filters').textContent = lang.labelApplyFilters;
  
  // 下拉選單預設選項
  const optPlaceholderDate = document.getElementById('opt-placeholder-date');
  if (optPlaceholderDate) {
    optPlaceholderDate.textContent = lang.placeholderDate;
  }
  ['opt-placeholder-start-date', 'opt-placeholder-end-date'].forEach(id => {
    const option = document.getElementById(id);
    if (option) option.textContent = lang.placeholderDate;
  });
  Array.from(gameCompareSlotSelect.options).forEach(option => {
    option.textContent = lang.gameOption.replace('{name}', formatGameNameOnly(option.value, option.dataset.gameName));
  });
  const optPlaceholderPlayer = document.getElementById('opt-placeholder-player');
  if (optPlaceholderPlayer) {
    optPlaceholderPlayer.textContent = lang.placeholderPlayer;
  }
  Array.from(playerGameSelect.options).forEach(option => {
    option.textContent = option.value === 'ALL'
      ? lang.allGames
      : lang.gameOption.replace('{name}', option.dataset.gameName || option.textContent);
  });
  
  // 指標看板
  document.getElementById('metrics-player-title').textContent = lang.metricsPlayerTitle;
  document.getElementById('metrics-range-title').textContent = lang.metricsRangeTitle;
  document.getElementById('label-stat-total-spins').textContent = lang.statTotalSpins;
  document.getElementById('label-stat-total-wager').textContent = lang.statTotalWager;
  document.getElementById('label-stat-total-payout').textContent = lang.statTotalPayout;
  document.getElementById('label-stat-total-net').textContent = lang.statTotalNet;
  document.getElementById('label-stat-first-spin').textContent = lang.statFirstSpin;
  document.getElementById('label-stat-last-update').textContent = lang.statLastUpdate;
  document.getElementById('label-stat-spins').textContent = lang.statSpins;
  document.getElementById('label-stat-wager').textContent = lang.statWager;
  document.getElementById('label-stat-payout').textContent = lang.statPayout;
  document.getElementById('label-stat-net').textContent = lang.statNet;
  document.getElementById('label-stat-switches').textContent = lang.statSwitches;
  document.getElementById('label-stat-free').textContent = lang.statFree;
  
  // 數據明細面板標題
  document.getElementById('table-panel-title').textContent = lang.tabTable;
  document.getElementById('game-wager-summary-title').textContent = lang.gameWagerSummaryTitle;
  document.getElementById('game-wager-th-game').textContent = lang.gameWagerGame;
  document.getElementById('game-wager-th-type').textContent = lang.gameWagerType;
  
  // 數據表表頭
  document.getElementById('th-seq').textContent = lang.thSeq;
  document.getElementById('th-time').textContent = lang.thTime;
  document.getElementById('th-slot').textContent = lang.thSlot;
  document.getElementById('th-bet-type').textContent = lang.thBetType;
  document.getElementById('th-switch').textContent = lang.thSwitch;
  document.getElementById('th-free').textContent = lang.thFree;
  document.getElementById('th-bet').textContent = lang.thBet;
  document.getElementById('th-prize').textContent = lang.thPrize;
  document.getElementById('th-net').textContent = lang.thNet;
  document.getElementById('th-cum').textContent = lang.thCum;
  
  // 數據表空資料列提示
  const tdEmpty = document.getElementById('td-empty');
  if (tdEmpty) {
    tdEmpty.textContent = lang.tdEmpty;
  }

  if (monthlyDataCache.length) {
    if (monthlyModeSelect.value === 'compare') renderMonthlyComparisonCharts(monthlyDataCache);
    else renderMonthlyCharts(monthlyDataCache);
  }
  if (monthlyGameRankingCache.length) renderMonthlyGameRanking();
  if (gameDataCache.length && gameCompareCheckbox.checked && gameCompareSlotSelect.value) loadGameData();
  else if (gameDataCache.length) renderGameCharts(gameDataCache, gameSlotSelect.value || 'ALL', gameHourlyPlayersCache);
  if (gameDataCache.length) renderGameDailyBetStats(gameDataCache, gameSlotSelect.value || 'ALL', gameComparisonDataCache, gameComparisonSlotCache);
  if (gameSpinDistributionCache.length && gameSlotSelect.value !== 'ALL') {
    renderGameSpinDistribution(gameSpinDistributionCache, 'game-spin-distribution-chart', gameSeriesName(gameSlotSelect.value, gameSpinDistributionCache));
  }
  if (gameComparisonDataCache.length && gameComparisonSlotCache) {
    renderGameSpinDistribution(gameComparisonDataCache, 'game-compare-spin-distribution-chart', gameSeriesName(gameComparisonSlotCache, gameComparisonDataCache));
  }
  if (gameRankingCache.length && gameSlotSelect.value === 'ALL') renderGameRanking();
  if (homeDashboardCache) renderHomeDashboard(homeDashboardCache);
  if (agentAnalysisCache) renderAgentAnalysis(agentAnalysisCache);
  if (analyzedData.length) renderDashboard();
}

// ----------------------------------------------------
// 使用者操作事件監聽 (Events Listeners)
// ----------------------------------------------------

// 點擊繁中/EN語系切換
btnLangToggle.addEventListener('click', () => {
  currentLang = currentLang === 'zh' ? 'en' : 'zh';
  updateLanguageUI();
  saveUiState();
  
  // 若已載入過資料，同步重新語系化下拉選單內「玩家 ID: X」的顯示字串
  const mode = dateModeSelect.value;
  let startDate, endDate;
  if (mode === 'single') {
    startDate = dateSelect.value;
    endDate = dateSelect.value;
  } else {
    startDate = dateStartSelect.value;
    endDate = dateEndSelect.value;
  }
  const activePlayer = playerSelect.value;
  if (startDate && endDate && activePlayersList.length > 0) {
    repopulatePlayerDropdown(startDate, endDate, activePlayer);
  } else if (startDate && endDate) {
    markFiltersPending();
  }
});

// 當前日期篩選模式變更
dateModeSelect.addEventListener('change', () => {
  const mode = dateModeSelect.value;
  if (mode === 'single') {
    containerSingleDate.style.display = 'block';
    containerRangeDate.style.display = 'none';
  } else {
    containerSingleDate.style.display = 'none';
    containerRangeDate.style.display = 'block';
  }
  markFiltersPending();
});

// 各個日期下拉選單改變，只標記待篩選；按下篩選按鈕才重新加載玩家 ID 清單
dateSelect.addEventListener('change', () => {
  markFiltersPending();
});
dateStartSelect.addEventListener('change', () => {
  markFiltersPending();
});
dateEndSelect.addEventListener('change', () => {
  markFiltersPending();
});

playerGameSelect.addEventListener('change', () => {
  markFiltersPending();
});

// Spin 數範圍輸入框改變，只標記待篩選；按下篩選按鈕才重新加載玩家 ID 清單
minSpinsInput.addEventListener('change', () => {
  normalizeSpinRangeInputs();
  markFiltersPending();
});

maxSpinsInput.addEventListener('change', () => {
  normalizeSpinRangeInputs();
  markFiltersPending();
});

btnApplyFilters.addEventListener('click', () => {
  normalizeSpinRangeInputs();
  triggerLoadPlayers();
});

// 玩家 ID 下拉選單改變，重新載入該玩家的投注區間明細
playerSelect.addEventListener('change', () => {
  const mode = dateModeSelect.value;
  let startDate, endDate;
  if (mode === 'single') {
    startDate = dateSelect.value;
    endDate = dateSelect.value;
  } else {
    startDate = dateStartSelect.value;
    endDate = dateEndSelect.value;
  }
  const selectedPlayer = playerSelect.value;
  updatePlayerAnalysisButtonState();
  if (startDate && endDate && selectedPlayer) {
    loadAnalyzedData(startDate, endDate, selectedPlayer);
  } else {
    resetDashboardState();
  }
});

// 篩選框互斥邏輯：新老互斥、贏輸互斥；狀態改變時等待使用者按篩選
checkboxNewPlayer.addEventListener('change', () => {
  if (checkboxNewPlayer.checked) checkboxOldPlayer.checked = false;
  markFiltersPending();
});

checkboxOldPlayer.addEventListener('change', () => {
  if (checkboxOldPlayer.checked) checkboxNewPlayer.checked = false;
  markFiltersPending();
});

checkboxWinPlayer.addEventListener('change', () => {
  if (checkboxWinPlayer.checked) checkboxLosePlayer.checked = false;
  markFiltersPending();
});

checkboxLosePlayer.addEventListener('change', () => {
  if (checkboxLosePlayer.checked) checkboxWinPlayer.checked = false;
  markFiltersPending();
});

// ----------------------------------------------------
// 後端 REST API 請求與串接
// ----------------------------------------------------

async function loadPlayerGames() {
  if (currentPlayerGamesRequestController) currentPlayerGamesRequestController.abort();
  currentPlayerGamesRequestController = new AbortController();
  const requestController = currentPlayerGamesRequestController;
  const previousGame = playerGameSelect.value;
  playerGameSelect.disabled = true;
  playerGameSelect.innerHTML = `<option value="ALL">${translations[currentLang].loading}</option>`;
  try {
    const response = await fetch('/api/player-games', { signal: requestController.signal });
    const games = await response.json();
    if (!response.ok) throw new Error(translations[currentLang].apiRequestFailed);
    if (currentPlayerGamesRequestController !== requestController) return;

    const options = document.createDocumentFragment();
    const allGames = document.createElement('option');
    allGames.value = 'ALL';
    allGames.textContent = translations[currentLang].allGames;
    options.appendChild(allGames);
    games.forEach(game => {
      const option = document.createElement('option');
      option.value = String(game.slot_id);
      option.dataset.gameName = game.game_name;
      option.textContent = translations[currentLang].gameOption.replace('{name}', game.game_name);
      options.appendChild(option);
    });
    playerGameSelect.replaceChildren(options);
    const desiredGame = pendingPlayerGame !== 'ALL' ? pendingPlayerGame : previousGame;
    playerGameSelect.value = Array.from(playerGameSelect.options).some(option => option.value === desiredGame)
      ? desiredGame
      : 'ALL';
    pendingPlayerGame = 'ALL';
    saveUiState();
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('載入玩家分析遊戲清單失敗:', error);
    playerGameSelect.innerHTML = '';
    const allGames = document.createElement('option');
    allGames.value = 'ALL';
    allGames.textContent = translations[currentLang].allGames;
    const errorOption = document.createElement('option');
    errorOption.disabled = true;
    errorOption.textContent = `⚠️ ${translations[currentLang].playerGamesLoadFailed}`;
    playerGameSelect.append(allGames, errorOption);
  } finally {
    if (currentPlayerGamesRequestController === requestController) {
      currentPlayerGamesRequestController = null;
      playerGameSelect.disabled = false;
    }
  }
}

function loadAvailableDates() {
  // 自 API /api/dates 獲取可選的分區日期清單，並預設加載首個日期
  fetch('/api/dates')
    .then(res => {
      if (!res.ok) {
        return res.json().then(() => { throw new Error(translations[currentLang].apiRequestFailed); });
      }
      return res.json();
    })
    .then(dates => {
      dateSelect.innerHTML = '';
      dateStartSelect.innerHTML = '';
      dateEndSelect.innerHTML = '';
      
      if (dates.length === 0) {
        const errMsg = translations[currentLang].noDates;
        [dateSelect, dateStartSelect, dateEndSelect].forEach(sel => {
          const opt = document.createElement('option');
          opt.value = "";
          opt.textContent = errMsg;
          sel.appendChild(opt);
        });
        return;
      }
      
      monthlyLatestAvailableDate = dates[0];

      dates.forEach(d => {
        // 單一日期
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        dateSelect.appendChild(opt);
        
        // 開始日期
        const optStart = document.createElement('option');
        optStart.value = d;
        optStart.textContent = d;
        dateStartSelect.appendChild(optStart);
        
        // 結束日期
        const optEnd = document.createElement('option');
        optEnd.value = d;
        optEnd.textContent = d;
        dateEndSelect.appendChild(optEnd);
      });
      
      // 設定預設值：單一日期與結束日期為最新日期，開始日期為最新日期往前一個月內的最早可選日期
      dateSelect.value = dates[0];
      dateEndSelect.value = dates[0];
      dateStartSelect.value = getDefaultRangeStartDate(dates, dates[0]);

      const savedPlayer = restoredUiState?.player;
      if (savedPlayer) {
        if (dates.includes(savedPlayer.date)) dateSelect.value = savedPlayer.date;
        if (dates.includes(savedPlayer.startDate)) dateStartSelect.value = savedPlayer.startDate;
        if (dates.includes(savedPlayer.endDate)) dateEndSelect.value = savedPlayer.endDate;
      }
      
      markFiltersPending();
      saveUiState();
      if (restoredUiState?.activePage === 'player' && pendingPlayerId) triggerLoadPlayers();
    })
    .catch(err => {
      console.error("載入可用日期發生錯誤:", err);
      const errMsg = `⚠️ ${err.message}`;
      [dateSelect, dateStartSelect, dateEndSelect].forEach(sel => {
        sel.innerHTML = `<option value="">${errMsg}</option>`;
      });
      resetDashboardState();
    });
}

function triggerLoadPlayers() {
  const mode = dateModeSelect.value;
  let startDate, endDate;
  if (mode === 'single') {
    startDate = dateSelect.value;
    endDate = dateSelect.value;
  } else {
    startDate = dateStartSelect.value;
    endDate = dateEndSelect.value;
  }
  
  if (!startDate || !endDate) {
    resetDashboardState();
    return;
  }
  
  // 日期區間合法性驗證 (開始日期不得大於結束日期)
  if (startDate > endDate) {
    playerSelect.innerHTML = `<option value="">⚠️ ${translations[currentLang].dateOrderError}</option>`;
    resetDashboardState();
    return;
  }

  if (mode === 'range' && isDateRangeOverOneYear(startDate, endDate)) {
    playerSelect.innerHTML = `<option value="">⚠️ ${translations[currentLang].rangeLimitError}</option>`;
    resetDashboardState();
    return;
  }
  
  loadPlayersForDate(startDate, endDate);
}

let activePlayersList = []; // 用於快取目前加載的玩家 ID 陣列

function updatePlayerAnalysisButtonState() {
  btnOpenSinglePlayer.disabled = !playerSelect.value;
}

function markFiltersPending() {
  activePlayersList = [];
  playerSelect.innerHTML = `<option value="" id="opt-placeholder-player">${translations[currentLang].placeholderApplyFilters}</option>`;
  updatePlayerAnalysisButtonState();
  resetDashboardState();
}

function setFilterLoading(isLoading) {
  btnApplyFilters.disabled = isLoading;
  btnApplyFilters.style.opacity = isLoading ? '0.7' : '';
  btnApplyFilters.style.cursor = isLoading ? 'not-allowed' : '';
  document.getElementById('label-apply-filters').textContent = isLoading
    ? translations[currentLang].loading
    : translations[currentLang].labelApplyFilters;
}

function loadPlayersForDate(startDate, endDate) {
  // 依據當前選定的日期與 4 個篩選方塊狀態，獲取過濾後的玩家清單
  const newPlayer = checkboxNewPlayer.checked;
  const oldPlayer = checkboxOldPlayer.checked;
  const winPlayer = checkboxWinPlayer.checked;
  const losePlayer = checkboxLosePlayer.checked;
  const minSpins = getMinSpinsValue();
  const maxSpins = getMaxSpinsValue();
  
  const queryParams = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    new_player: newPlayer,
    old_player: oldPlayer,
    win_player: winPlayer,
    lose_player: losePlayer,
    min_spins: minSpins,
    max_spins: maxSpins
  });
  queryParams.set('slot_id', playerGameSelect.value || 'ALL');

  if (currentPlayersRequestController) {
    currentPlayersRequestController.abort();
  }
  currentPlayersRequestController = new AbortController();
  const requestController = currentPlayersRequestController;
  const timeoutId = setTimeout(() => {
    requestController.abort();
  }, 30000);

  activePlayersList = [];
  playerSelect.innerHTML = `<option value="">${translations[currentLang].placeholderLoadingPlayers}</option>`;
  updatePlayerAnalysisButtonState();
  resetDashboardState();
  setFilterLoading(true);
  
  fetch(`/api/players?${queryParams.toString()}`, { signal: requestController.signal })
    .then(res => {
      if (!res.ok) {
        return res.json().then(() => { throw new Error(translations[currentLang].apiRequestFailed); });
      }
      return res.json();
    })
    .then(players => {
      if (currentPlayersRequestController !== requestController) return;
      activePlayersList = players;
      repopulatePlayerDropdown(startDate, endDate, pendingPlayerId || null);
      if (pendingPlayerId && playerSelect.value) {
        const playerId = pendingPlayerId;
        pendingPlayerId = '';
        saveUiState();
        loadAnalyzedData(startDate, endDate, playerId);
      }
    })
    .catch(err => {
      if (err.name === 'AbortError' && currentPlayersRequestController !== requestController) return;
      const message = err.name === 'AbortError'
        ? translations[currentLang].filterTimeoutMessage
        : err.message;
      console.error(`讀取日期範圍 ${startDate} ~ ${endDate} 的玩家清單失敗:`, err);
      playerSelect.innerHTML = `<option value="">⚠️ ${message}</option>`;
      updatePlayerAnalysisButtonState();
      resetDashboardState();
    })
    .finally(() => {
      clearTimeout(timeoutId);
      if (currentPlayersRequestController === requestController) {
        currentPlayersRequestController = null;
        setFilterLoading(false);
      }
    });
}

function repopulatePlayerDropdown(startDate, endDate, selectPlayerId = null) {
  // 重新將 activePlayersList 快取的資料填入玩家下拉選單中
  if (activePlayersList.length === 0) {
    const opt = document.createElement('option');
    opt.value = "";
    opt.textContent = translations[currentLang].noPlayers;
    playerSelect.replaceChildren(opt);
    updatePlayerAnalysisButtonState();
    resetDashboardState();
    return;
  }

  const options = document.createDocumentFragment();
  const placeholderOpt = document.createElement('option');
  placeholderOpt.value = "";
  placeholderOpt.id = "opt-placeholder-player";
  placeholderOpt.textContent = translations[currentLang].placeholderSelectPlayer;
  options.appendChild(placeholderOpt);
  
  activePlayersList.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = translations[currentLang].playerOption.replace('{player}', p);
    options.appendChild(opt);
  });
  playerSelect.replaceChildren(options);
  
  // 保留或預設選擇指定玩家 ID
  if (selectPlayerId && activePlayersList.includes(String(selectPlayerId))) {
    playerSelect.value = String(selectPlayerId);
  } else {
    playerSelect.value = "";
  }
  updatePlayerAnalysisButtonState();
}

function loadAnalyzedData(startDate, endDate, player_id) {
  if (currentDataRequestController) {
    currentDataRequestController.abort();
    currentDataRequestController = null;
  }

  if (!player_id) {
    resetDashboardState();
    return;
  }
  currentDataRequestController = new AbortController();
  const requestController = currentDataRequestController;
  const timeoutId = setTimeout(() => {
    requestController.abort();
  }, 30000);
  
  const newPlayer = checkboxNewPlayer.checked;
  const oldPlayer = checkboxOldPlayer.checked;
  const winPlayer = checkboxWinPlayer.checked;
  const losePlayer = checkboxLosePlayer.checked;
  const minSpins = getMinSpinsValue();
  const maxSpins = getMaxSpinsValue();
  
  const queryParams = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    player_id: player_id
  });
  
  queryParams.set('new_player', newPlayer);
  queryParams.set('old_player', oldPlayer);
  queryParams.set('win_player', winPlayer);
  queryParams.set('lose_player', losePlayer);
  queryParams.set('min_spins', minSpins);
  queryParams.set('max_spins', maxSpins);
  queryParams.set('slot_id', playerGameSelect.value || 'ALL');
  tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-secondary); font-weight: bold;">${translations[currentLang].placeholderLoadingPlayers}</td></tr>`;
  
  // 自 API /api/data 獲取指定日期和玩家的投注紀錄，並送入前端進行即時計算
  fetch(`/api/data?${queryParams.toString()}`, { signal: requestController.signal })
    .then(res => {
      if (!res.ok) {
        return res.json().then(() => { throw new Error(translations[currentLang].apiRequestFailed); });
      }
      return res.json();
    })
    .then(records => {
      if (currentDataRequestController !== requestController) return;
      processAndRender(records);
    })
    .catch(err => {
      if (err.name === 'AbortError' && currentDataRequestController !== requestController) return;
      const message = err.name === 'AbortError'
        ? translations[currentLang].filterTimeoutMessage
        : err.message;
      console.error(`讀取玩家 ${player_id} 於日期範圍 ${startDate} ~ ${endDate} 的投注明細失敗:`, err);
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--danger); font-weight: bold;">⚠️ ${translations[currentLang].loadFailed.replace('{message}', message)}</td></tr>`;
    })
    .finally(() => {
      clearTimeout(timeoutId);
      if (currentDataRequestController === requestController) {
        currentDataRequestController = null;
      }
    });
}

async function loadSinglePlayerData(playerId = '') {
  const lang = translations[currentLang];
  const playerName = singlePlayerName.value.trim();
  const startDate = singlePlayerStartDate.value;
  const endDate = singlePlayerEndDate.value;
  if (!playerId && !playerName) {
    setLocalizedStatus(singlePlayerStatus, 'singlePlayerNameRequired');
    singlePlayerName.focus();
    return;
  }
  if (!startDate || !endDate || startDate > endDate) {
    setLocalizedStatus(singlePlayerStatus, 'dateOrderError');
    return;
  }

  singlePlayerSubmit.disabled = true;
  singlePlayerSubmit.textContent = lang.singlePlayerQuerying;
  singlePlayerContent.classList.add('is-loading');
  singlePlayerContent.setAttribute('aria-busy', 'true');
  setLocalizedStatus(singlePlayerStatus, 'singlePlayerLoading');
  tableBody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--text-secondary);">${lang.singlePlayerLoading}</td></tr>`;
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
  if (playerId) {
    params.set('player_id', String(playerId));
    params.set('max_spins', String(Number.MAX_SAFE_INTEGER));
  } else {
    params.set('player_name', playerName);
  }
  try {
    const response = await fetch(`/api/data?${params}`);
    const records = await response.json();
    if (!response.ok) throw new Error(lang.apiRequestFailed);
    if (!records.length) {
      singlePlayerContext = null;
      resetDashboardState();
      setLocalizedStatus(singlePlayerStatus, 'singlePlayerNoData');
      return;
    }
    singlePlayerContext = {
      name: records[0].player_username || playerName || String(playerId),
      playerId: String(records[0].player_id),
      startDate,
      endDate
    };
    processAndRender(records);
    setLocalizedStatus(singlePlayerStatus, 'singlePlayerLoaded', {
      name: singlePlayerContext.name,
      start: startDate,
      end: endDate,
      count: records.length
    });
  } catch (error) {
    singlePlayerContext = null;
    resetDashboardState();
    setLocalizedStatus(singlePlayerStatus, 'loadFailed', { message: error.message });
  } finally {
    singlePlayerContent.classList.remove('is-loading');
    singlePlayerContent.removeAttribute('aria-busy');
    singlePlayerSubmit.disabled = false;
    singlePlayerSubmit.textContent = translations[currentLang].singlePlayerSubmit;
  }
}

singlePlayerForm.addEventListener('submit', event => {
  event.preventDefault();
  loadSinglePlayerData();
});

// ----------------------------------------------------
// 前端即時分析、運算與渲染
// ----------------------------------------------------

function processAndRender(records) {
  // 對後端回傳的原始流水資料進行順序標記、切換檢測及累計利潤的即時運算
  if (records.length === 0) {
    resetDashboardState();
    return;
  }
  
  const playerStates = new Map();
  
  // 將資料庫回傳的投注資訊映射為完整的分析特徵陣列
  analyzedData = records.map(record => {
    const playerId = String(record.player_id);
    const state = playerStates.get(playerId) || {
      playSeq: 0,
      prevSlotId: null,
      cumProfit: 0
    };
    state.playSeq++;
    
    // 判斷是否發生切換老虎機遊戲 (比對上一次與本次的 slot_id)
    const slotId = Number(record.slot_id);
    let is_game_changed = false;
    if (state.prevSlotId !== null && state.prevSlotId !== slotId) {
      is_game_changed = true;
    }
    state.prevSlotId = slotId;
    
    // 計算該筆投注的淨利潤
    const bet = Number(record.bet_amount || 0);
    const prize = Number(record.total_prize || 0);
    const net_profit = prize - bet;
    state.cumProfit += net_profit; // 累加利潤
    playerStates.set(playerId, state);
    
    return {
      play_seq: state.playSeq,
      player_id: playerId,
      bet_at_utc7: new Date(record.bet_at_utc7),
      slot_id: slotId,
      game_name: record.game_name,
      bet_type: record.bet_type,
      is_game_changed: is_game_changed,
      has_free_game: Boolean(record.has_free_game),
      bet_amount: bet,
      total_prize: prize,
      stats_first_spin_date: record.stats_first_spin_date,
      stats_total_bet_amount: parseNullableNumber(record.stats_total_bet_amount),
      stats_total_win_amount: parseNullableNumber(record.stats_total_win_amount),
      stats_spin_count: parseNullableNumber(record.stats_spin_count),
      stats_last_spin_at: record.stats_last_spin_at,
      net_profit: net_profit,
      daily_cum_profit: state.cumProfit
    };
  });
  
  renderDashboard();
}

function renderDashboard() {
  // 將計算後的分析數據更新至前端看板指標與結果表格，並呼叫 Plotly 繪圖
  if (analyzedData.length === 0) return;
  
  const singleMode = document.querySelector('main').classList.contains('single-player-page') && singlePlayerContext;
  const player = singleMode ? `${singlePlayerContext.name} (ID ${singlePlayerContext.playerId})` : playerSelect.value;
  const mode = dateModeSelect.value;
  const dateText = singleMode
    ? `${singlePlayerContext.startDate} ~ ${singlePlayerContext.endDate}`
    : (mode === 'single' ? dateSelect.value : `${dateStartSelect.value} ~ ${dateEndSelect.value}`);
  
  const lang = translations[currentLang];
  
  // 計算匯總看板指標
  let totalSpins = analyzedData.length;
  let totalWager = 0;
  let totalPayout = 0;
  let gameSwitches = 0;
  let freeGames = 0;
  
  analyzedData.forEach(row => {
    totalWager += row.bet_amount;
    totalPayout += row.total_prize;
    if (row.is_game_changed) gameSwitches++;
    if (row.has_free_game) freeGames++;
  });
  
  const netReturn = totalPayout - totalWager;
  
  const statsRow = analyzedData[0];
  const statsNetReturn = statsRow.stats_total_win_amount === null || statsRow.stats_total_bet_amount === null
    ? null
    : statsRow.stats_total_win_amount - statsRow.stats_total_bet_amount;

  metricStatsSpins.textContent = formatCount(statsRow.stats_spin_count);
  metricStatsTotalWager.textContent = formatNullableCurrency(statsRow.stats_total_bet_amount);
  metricStatsTotalPayout.textContent = formatNullableCurrency(statsRow.stats_total_win_amount);
  metricStatsNetProfit.textContent = formatNullableCurrency(statsNetReturn);
  metricStatsNetProfit.className = 'metric-value ' + getProfitClass(statsNetReturn);
  metricStatsFirstSpin.textContent = statsRow.stats_first_spin_date || "--";
  metricStatsLastUpdate.textContent = formatDateTimeText(statsRow.stats_last_spin_at);

  // 渲染範圍內指標 counters，採用千分位金流格式化
  metricTotalSpins.textContent = totalSpins;
  metricTotalWager.textContent = formatCurrency(totalWager);
  metricTotalPayout.textContent = formatCurrency(totalPayout);
  
  metricNetProfit.textContent = formatCurrency(netReturn);
  metricNetProfit.className = 'metric-value ' + (netReturn >= 0 ? 'profit-positive' : 'profit-negative');
  
  metricGameSwitches.textContent = gameSwitches;
  metricFreeGames.textContent = freeGames;
  renderGameWagerSummary(analyzedData, lang);
  
  // 清空數據表格並逐列渲染填入明細 (限制最高 5,000 筆以防 DOM 凍結)
  tableBody.innerHTML = '';
  const MAX_TABLE_ROWS = 5000;
  const rowsToRender = analyzedData.slice(0, MAX_TABLE_ROWS);
  const htmlRuns = [];
  
  rowsToRender.forEach(row => {
    // 是否切換遊戲事件狀態標籤
    const isSwitchedCell = row.is_game_changed 
      ? `<span class="badge badge-game-changed">${lang.badgeChanged}</span>` 
      : `<span style="color:var(--text-secondary);">--</span>`;
      
    // 是否為免費遊戲狀態標籤
    const isFreeCell = row.has_free_game 
      ? `<span class="badge badge-free-game">${lang.badgeFree}</span>` 
      : `<span style="color:var(--text-secondary);">--</span>`;
      
    // 淨利數值與正負顏色 class 決定
    const spinNet = row.net_profit;
    const netClass = spinNet > 0 ? 'color: var(--success);' : (spinNet < 0 ? 'color: var(--danger);' : '');
    const timestampStr = formatDateTimeForTooltip(row.bet_at_utc7);
    
    const betTypeStr = getBetTypeLabel(row.bet_type, lang);
    
    htmlRuns.push(`
      <tr>
        <td style="font-family: var(--font-mono); font-weight:600;">#${row.play_seq}</td>
        <td style="color: var(--text-secondary);">${timestampStr}</td>
        <td style="font-family: var(--font-mono);">${formatGameNameOnly(row.slot_id, row.game_name)}</td>
        <td style="font-size: 0.85rem;">${betTypeStr}</td>
        <td>${isSwitchedCell}</td>
        <td>${isFreeCell}</td>
        <td>${formatCount(row.bet_amount)}</td>
        <td>${formatCount(row.total_prize)}</td>
        <td style="${netClass}">${spinNet > 0 ? '+' : ''}${formatCount(spinNet)}</td>
        <td style="font-family: var(--font-mono); font-weight:bold; ${row.daily_cum_profit >= 0 ? 'color: var(--success)' : 'color: var(--danger)'}">
          ${formatCount(row.daily_cum_profit)}
        </td>
      </tr>
    `);
  });
  
  // 若筆數超出限制，於底部顯示提示
  if (analyzedData.length > MAX_TABLE_ROWS) {
    htmlRuns.push(`
      <tr>
        <td colspan="10" style="text-align: center; color: var(--warning); font-weight: bold; padding: 1rem; background: rgba(245, 158, 11, 0.05);">
          ⚠️ ${translations[currentLang].showingRecords.replace('{total}', analyzedData.length)}
        </td>
      </tr>
    `);
  }
  
  tableBody.innerHTML = htmlRuns.join('');
  
  // 將圖表工作排到下一個畫面更新，先讓表格與查詢狀態完成繪製。
  if (chartRenderFrame !== null) cancelAnimationFrame(chartRenderFrame);
  chartRenderFrame = requestAnimationFrame(() => {
    chartRenderFrame = null;
  renderPlotlyChart(getOptimizedChartData(analyzedData), player, dateText);
  });
}

function renderGameWagerSummary(rows, lang) {
  const groups = new Map();
  rows.forEach(row => {
    const gameName = formatGameNameOnly(row.slot_id, row.game_name);
    const betType = getBetTypeLabel(row.bet_type, lang);
    const key = `${gameName}\u0000${betType}`;
    const group = groups.get(key) || { gameName, betType, spins: 0, bet: 0, win: 0 };
    group.spins += 1;
    group.bet += row.bet_amount;
    group.win += row.total_prize;
    groups.set(key, group);
  });

  const summaryRows = [...groups.values()].sort((a, b) =>
    b.spins - a.spins || a.gameName.localeCompare(b.gameName)
  );
  gameWagerSummaryBody.innerHTML = summaryRows.map(group => `
    <tr>
      <td>${escapeHtml(group.gameName)}</td>
      <td>${escapeHtml(group.betType)}</td>
      <td>${formatCount(group.spins)}</td>
      <td>${formatCount(group.bet)}</td>
      <td>${formatCount(group.win)}</td>
    </tr>
  `).join('');
}

function getOptimizedChartData(rows) {
  if (rows.length <= MAX_CHART_POINTS) return rows;
  const selected = new Map();
  const stride = Math.ceil(rows.length / MAX_CHART_POINTS);
  selected.set(0, rows[0]);
  for (let index = stride; index < rows.length - 1; index += stride) {
    selected.set(index, rows[index]);
  }
  // 保留重要事件點，避免抽樣後遺失免費遊戲或遊戲切換標記。
  rows.forEach((row, index) => {
    if (row.has_free_game || row.is_game_changed) selected.set(index, row);
  });
  selected.set(rows.length - 1, rows[rows.length - 1]);
  return [...selected.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
}

function renderPlotlyChart(chartData, player, date) {
  // 使用 Plotly.js 對分析後的數據點進行渲染，包含 Tooltips 進階顯示
  const lang = translations[currentLang];
  const isSinglePlayerChart = document.querySelector('main').classList.contains('single-player-page');
  const hoverTemplate = 
    `<b>Player ID:</b> %{customdata[6]}<br>` +
    `<b>${lang.tooltipSeq}:</b> #%{x}<br>` +
    `<b>${lang.tooltipTime}:</b> %{customdata[4]}<br>` +
    `<b>${lang.thBetType}:</b> %{customdata[5]}<br>` +
    `<b>${lang.tooltipSlot}:</b> %{customdata[3]}<br>` +
    `<b>${lang.tooltipCumProfit}:</b> %{y:,.0f} IDR<br>` +
    `<b>${lang.tooltipNetProfit}:</b> %{customdata[0]}<br>` +
    `<b>${lang.tooltipBet}:</b> %{customdata[1]} | <b>${lang.tooltipPrize}:</b> %{customdata[2]}<br>` +
    "<extra></extra>";

  // 1. 依 bet_type 將累計利潤曲線分段上色
  const betTypeSegments = new Map();
  chartData.forEach((row, idx) => {
    const betTypeKey = getBetTypeKey(row.bet_type);
    if (!betTypeSegments.has(betTypeKey)) {
      betTypeSegments.set(betTypeKey, {
        betType: row.bet_type,
        x: [],
        y: [],
        customdata: []
      });
    }

    const segment = betTypeSegments.get(betTypeKey);
    if (idx === 0) {
      segment.x.push(row.play_seq);
      segment.y.push(row.daily_cum_profit);
      segment.customdata.push(buildChartCustomData(row, lang));
      return;
    }

    const prevRow = chartData[idx - 1];
    segment.x.push(prevRow.play_seq, row.play_seq, null);
    segment.y.push(prevRow.daily_cum_profit, row.daily_cum_profit, null);
    segment.customdata.push(buildChartCustomData(prevRow, lang), buildChartCustomData(row, lang), null);
  });

  const profitTraces = Array.from(betTypeSegments.values()).map(segment => ({
    x: segment.x,
    y: segment.y,
    customdata: segment.customdata,
    mode: 'lines+markers',
    name: `${lang.chartLegendProfit} - ${getBetTypeLabel(segment.betType, lang)}`,
    line: {
      color: getBetTypeColor(segment.betType),
      width: 3.5,
      shape: 'linear'
    },
    marker: {
      size: 5,
      color: getBetTypeColor(segment.betType)
    },
    hovertemplate: hoverTemplate,
    type: 'scattergl'
  }));

  // 2. 設置免費遊戲標記點 Trace (has_free_game = True)
  const fgDataset = chartData.filter(r => r.has_free_game);
  const freeGameTrace = {
    x: fgDataset.map(r => r.play_seq),
    y: fgDataset.map(r => r.daily_cum_profit),
    mode: 'markers',
    name: lang.chartLegendFg,
    marker: {
      symbol: 'star',
      size: 13,
      color: '#10b981',
      line: {
        color: '#ffffff',
        width: 1.5
      }
    },
    hovertemplate: 
      `<b>${lang.tooltipFreeGame}</b><br>` +
      `${lang.tooltipSeq}: #%{x}<br>` +
      `${lang.tooltipCumShort}: %{y:,.0f} IDR<br>` +
      "<extra></extra>",
    type: 'scattergl'
  };

  // 3. 設置切換遊戲標記點 Trace (is_game_changed = True)
  const gsDataset = chartData.filter(r => r.is_game_changed);
  const gameSwitchTrace = {
    x: gsDataset.map(r => r.play_seq),
    y: gsDataset.map(r => r.daily_cum_profit),
    mode: 'markers',
    name: lang.chartLegendGs,
    marker: {
      symbol: 'diamond',
      size: 12,
      color: '#f59e0b',
      line: {
        color: '#ffffff',
        width: 1.5
      }
    },
    hovertemplate: 
      `<b>${lang.tooltipSwitch}</b><br>` +
      `${lang.tooltipSeq}: #%{x}<br>` +
      `${lang.tooltipNewGame}: %{text}<br>` +
      `${lang.tooltipCumShort}: %{y:,.0f} IDR<br>` +
      "<extra></extra>",
    text: gsDataset.map(r => formatGameNameOnly(r.slot_id, r.game_name)),
    type: 'scattergl'
  };

  // 圖表版面與樣式細部設定（對齊淺色玻璃擬態面板風格）
  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(248, 250, 252, 0.72)',
    font: { family: 'Roboto Mono, SFMono-Regular, Consolas, monospace', color: '#475569' },
    margin: { l: 80, r: 40, t: 50, b: 50 },
    title: {
      text: lang.chartTitle.replace('{player}', player).replace('{date}', date),
      font: {
        color: '#0f172a',
        family: 'Outfit, sans-serif',
        size: 16
      }
    },
    xaxis: {
      title: lang.chartXAxis,
      gridcolor: 'rgba(15,23,42,0.09)',
      tickfont: { color: '#475569' },
      titlefont: { color: '#475569' },
      zerolinecolor: 'rgba(15,23,42,0.16)'
    },
    yaxis: {
      title: lang.chartYAxis,
      gridcolor: 'rgba(15,23,42,0.09)',
      tickfont: { color: '#475569' },
      titlefont: { color: '#475569' },
      zerolinecolor: 'rgba(15,23,42,0.16)',
      tickformat: ',' // 大金額格式化
    },
    ...(isSinglePlayerChart ? {
      yaxis2: {
        title: lang.chartLegendBet,
        overlaying: 'y',
        side: 'right',
        rangemode: 'tozero',
        showgrid: false,
        tickformat: ',',
        tickfont: { color: '#94a3b8' },
        titlefont: { color: '#94a3b8' }
      }
    } : {}),
    legend: {
      font: { color: '#475569' },
      bgcolor: 'rgba(255, 255, 255, 0.95)',
      bordercolor: 'rgba(15,23,42,0.1)',
      borderwidth: 1
    },
    hovermode: 'closest'
  };

  const config = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['select2d', 'lasso2d', 'toggleSpikelines']
  };

  const wagerTrace = {
    x: chartData.map(row => row.play_seq),
    y: chartData.map(row => row.bet_amount),
    name: lang.chartLegendBet,
    type: 'bar',
    yaxis: 'y2',
    marker: { color: 'rgba(148, 163, 184, 0.28)' },
    hovertemplate: `<b>${lang.tooltipSeq}:</b> #%{x}<br><b>${lang.tooltipBet}:</b> %{y:,.0f} IDR<extra></extra>`
  };
  const dataTraces = isSinglePlayerChart ? [wagerTrace, ...profitTraces] : [...profitTraces];
  if (fgDataset.length > 0) dataTraces.push(freeGameTrace);
  if (gsDataset.length > 0) dataTraces.push(gameSwitchTrace);

  Plotly.react('chart-viewport', dataTraces, layout, config);
}

function resetDashboardState() {
  // 重置清空目前指標數據看板、表格與圖表至初始狀態
  analyzedData = [];
  gameWagerSummaryBody.innerHTML = `<tr><td colspan="5" class="table-empty-message">--</td></tr>`;
  if (chartRenderFrame !== null) {
    cancelAnimationFrame(chartRenderFrame);
    chartRenderFrame = null;
  }
  
  metricStatsSpins.textContent = "0";
  metricStatsTotalWager.textContent = "0 IDR";
  metricStatsTotalPayout.textContent = "0 IDR";
  metricStatsNetProfit.textContent = "0 IDR";
  metricStatsNetProfit.className = 'metric-value';
  metricStatsFirstSpin.textContent = "--";
  metricStatsLastUpdate.textContent = "--";
  metricTotalSpins.textContent = "0";
  metricTotalWager.textContent = "0 IDR";
  metricTotalPayout.textContent = "0 IDR";
  metricNetProfit.textContent = "0 IDR";
  metricNetProfit.className = 'metric-value';
  metricGameSwitches.textContent = "0";
  metricFreeGames.textContent = "0";
  
  tableBody.innerHTML = `
    <tr>
      <td id="td-empty" colspan="10" style="text-align: center; color: var(--text-secondary); padding: 2rem;">
        ${translations[currentLang].tdEmpty}
      </td>
    </tr>
  `;
  
  const gd = document.getElementById('chart-viewport');
  if (gd && gd.layout) {
    Plotly.purge(gd);
  }
}

function getMinSpinsValue() {
  const parsedValue = parseInt(minSpinsInput.value, 10);
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : 0;
}

function getMaxSpinsValue() {
  const minSpins = getMinSpinsValue();
  const parsedValue = parseInt(maxSpinsInput.value, 10);
  const maxSpins = Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : 10000;
  return Math.max(maxSpins, minSpins);
}

function normalizeSpinRangeInputs() {
  minSpinsInput.value = getMinSpinsValue();
  maxSpinsInput.value = getMaxSpinsValue();
}

function getProfitClass(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '';
  return Number(value) >= 0 ? 'profit-positive' : 'profit-negative';
}

function getBetTypeKey(betType) {
  return betType === null || betType === undefined ? 'unknown' : String(betType);
}

function getBetTypeLabel(betType, lang) {
  if (betType === undefined || betType === null) return '--';
  const bType = Number(betType);
  if (bType === 1) return lang.betTypeNormal;
  if (bType === 2) return lang.betTypeAnte;
  if (bType === 3) return lang.betTypeBuy;
  return lang.betTypeUnknown;
}

function getBetTypeColor(betType) {
  const bType = Number(betType);
  if (bType === 1) return '#6366f1';
  if (bType === 2) return '#f59e0b';
  if (bType === 3) return '#10b981';
  return '#94a3b8';
}

function formatGameDisplay(slotId, gameName) {
  return translations[currentLang].gameOption.replace(
    '{name}',
    formatGameNameOnly(slotId, gameName)
  );
}

function buildChartCustomData(row, lang) {
  return [
    formatCurrency(row.net_profit),
    formatCurrency(row.bet_amount),
    formatCurrency(row.total_prize),
    formatGameDisplay(row.slot_id, row.game_name),
    formatDateTimeForTooltip(row.bet_at_utc7),
    getBetTypeLabel(row.bet_type, lang),
    row.player_id
  ];
}

function formatGameNameOnly(slotId, gameName) {
  const normalizedName = String(gameName || '').trim();
  return normalizedName && normalizedName !== String(slotId)
    ? normalizedName
    : translations[currentLang].unknownGame;
}

function renderHomeDashboard(data) {
  const lang = translations[currentLang];
  const currentMonth = data.current_month || {};
  const previousMonth = data.previous_month || {};
  const currentDay = data.current_day || {};
  const referenceDate = data.reference_date || data.latest_date || '--';
  const sevenDayStart = referenceDate === '--' ? '' : shiftGameDate(referenceDate, -6);
  document.getElementById('home-data-date').textContent = lang.homeDataDate.replace('{date}', data.latest_date || '--');
  document.getElementById('home-month-range').textContent = lang.homeMonthRangeComparison
    .replace('{currentStart}', data.current_month_start || '--')
    .replace('{currentEnd}', referenceDate)
    .replace('{previousStart}', data.previous_month_start || '--')
    .replace('{previousEnd}', data.previous_month_end || '--');
  document.getElementById('home-day-date').textContent = referenceDate;

  const kpis = [
    ['spins', 'total_spin_count'], ['bet', 'total_bet_amount'],
    ['win', 'total_win_amount'], ['ggr', 'ggr']
  ];
  kpis.forEach(([id, key]) => {
    document.getElementById(`home-month-${id}`).textContent = formatCount(currentMonth[key]);
    document.getElementById(`home-day-${id}`).textContent = formatCount(currentDay[key]);
    const current = Number(currentMonth[key] || 0);
    const previous = Number(previousMonth[key] || 0);
    const deltaElement = document.getElementById(`home-month-${id}-delta`);
    if (!previous) {
      deltaElement.textContent = lang.homeComparedPrevious.replace('{value}', '--');
      deltaElement.className = 'home-kpi-delta';
    } else {
      const delta = (current - previous) / Math.abs(previous) * 100;
      const value = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
      deltaElement.textContent = lang.homeComparedPrevious.replace('{value}', value);
      deltaElement.className = `home-kpi-delta ${delta >= 0 ? 'positive' : 'negative'}`;
    }
  });

  const ggrRows = data.ggr_30d || [];
  Plotly.newPlot('home-ggr-chart', [{
    x: ggrRows.map(row => row.date), y: ggrRows.map(row => Number(row.ggr || 0)),
    name: 'GGR', type: 'bar', marker: { color: ggrRows.map(row => Number(row.ggr || 0) >= 0 ? '#10b981' : '#ef4444') },
    hovertemplate: '%{x}<br>GGR: %{y:,.0f} IDR<extra></extra>'
  }, {
    x: ggrRows.map(row => row.date), y: ggrRows.map(row => Number(row.dau || 0)),
    name: 'DAU', type: 'scatter', mode: 'lines+markers', yaxis: 'y2',
    line: { color: '#38bdf8', width: 3 }, marker: { size: 6 },
    hovertemplate: '%{x}<br>DAU: %{y:,.0f}<extra></extra>'
  }], monthlyChartLayout(lang.homeGgr30d, lang.axisGgr, {
    margin: { l: 65, r: 65, t: 48, b: 45 },
    yaxis2: {
      title: 'DAU', overlaying: 'y', side: 'right', rangemode: 'tozero',
      gridcolor: 'rgba(0,0,0,0)', tickfont: { color: '#0284c7' }
    }
  }), { responsive: true, displaylogo: false, displayModeBar: false });

  const hourlySpinRows = data.hourly_spins_24h || [];
  Plotly.newPlot('home-hourly-spins-chart', [{
    x: hourlySpinRows.map(row => row.hour),
    y: hourlySpinRows.map(row => Number(row.spin_count || 0)),
    name: 'Spin',
    type: 'bar',
    marker: { color: '#6366f1' },
    hovertemplate: `%{x|%Y-%m-%d %H:00}<br>${lang.totalSpinsLabel}: %{y:,.0f}<extra></extra>`
  }], monthlyChartLayout(lang.homeHourlySpins, lang.totalSpinsLabel, {
    margin: { l: 65, r: 20, t: 48, b: 55 },
    xaxis: { tickformat: '%m/%d %H:00', dtick: 3 * 60 * 60 * 1000 }
  }), { responsive: true, displaylogo: false, displayModeBar: false });

  const renderGameRows = (bodyId, rows, startDate, endDate) => {
    const body = document.getElementById(bodyId);
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="3">--</td></tr>';
      return;
    }
    body.innerHTML = rows.map(row => `<tr class="home-ranking-link-row" tabindex="0" role="link">
      <td>${escapeHtml(formatGameNameOnly(row.slot_id, row.game_name))}</td><td>${formatCount(row.total_spin_count)}</td><td>${formatCount(row.ggr)}</td>
    </tr>`).join('');
    Array.from(body.rows).forEach((tableRow, index) => {
      const game = rows[index];
      const gameName = formatGameNameOnly(game.slot_id, game.game_name);
      tableRow.title = lang.openGameAnalysis.replace('{game}', gameName);
      tableRow.setAttribute('aria-label', tableRow.title);
      const openGameAnalysis = () => {
        gameDateModeSelect.value = startDate === endDate ? 'today' : 'seven-days';
        setGameDateMode();
        gameStartDate.value = startDate;
        gameEndDate.value = endDate;
        const slotId = String(game.slot_id);
        const slotIsLoaded = Array.from(gameSlotSelect.options).some(option => option.value === slotId);
        pendingGameSlot = slotIsLoaded ? '' : slotId;
        gameSlotSelect.value = slotIsLoaded ? slotId : 'ALL';
        setActivePage('game');
        if (gameLatestAvailableDate) loadGameData();
      };
      tableRow.addEventListener('click', openGameAnalysis);
      tableRow.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openGameAnalysis();
      });
    });
  };
  const renderPlayerRows = (bodyId, rows, startDate, endDate) => {
    const body = document.getElementById(bodyId);
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5">--</td></tr>';
      return;
    }
    body.innerHTML = rows.map(row => `<tr class="home-ranking-link-row" tabindex="0" role="link">
      <td>${escapeHtml(row.username || row.player_id)}</td><td>${formatCount(row.total_spin_count)}</td><td>${formatCount(row.total_bet_amount)}</td>
      <td>${formatCount(row.total_win_amount)}</td><td class="profit-positive">${formatCount(row.profit)}</td>
    </tr>`).join('');
    Array.from(body.rows).forEach((tableRow, index) => {
      const player = rows[index];
      const username = player.username || String(player.player_id);
      tableRow.title = lang.openPlayerAnalysis.replace('{player}', username);
      tableRow.setAttribute('aria-label', tableRow.title);
      const openPlayerAnalysis = () => {
        singlePlayerName.value = username;
        singlePlayerStartDate.value = startDate;
        singlePlayerEndDate.value = endDate;
        setLocalizedStatus(singlePlayerStatus, '');
        setActivePage('single-player');
        loadSinglePlayerData(player.player_id);
      };
      tableRow.addEventListener('click', openPlayerAnalysis);
      tableRow.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openPlayerAnalysis();
      });
    });
  };
  renderGameRows('home-game-7d-body', data.game_rankings?.seven_day || [], sevenDayStart, referenceDate);
  renderGameRows('home-game-day-body', data.game_rankings?.current_day || [], referenceDate, referenceDate);
  const renderAgentPeriod = (chartId, bodyId, rows, title) => {
    const rankedRows = [...rows].sort((a, b) => Number(b.total_spin_count || 0) - Number(a.total_spin_count || 0));
    const pieTopRows = rankedRows.slice(0, 5);
    const tableTopRows = rankedRows.slice(0, 10);
    const otherSpins = rankedRows.slice(5).reduce((sum, row) => sum + Math.max(0, Number(row.total_spin_count || 0)), 0);
    const pieRows = otherSpins > 0
      ? [...pieTopRows, { agent_name: lang.other, total_spin_count: otherSpins }]
      : pieTopRows;
    const labels = pieRows.map(row => row.agent_id === undefined
      ? row.agent_name
      : `${row.parent_agent_name || row.parent_agent_id} / ${row.agent_name || row.agent_id}`);
    Plotly.newPlot(chartId, [{
      labels,
      values: pieRows.map(row => Math.max(0, Number(row.total_spin_count || 0))),
      type: 'pie',
      hole: 0.48,
      textinfo: 'label+percent',
      hovertemplate: `%{label}<br>${lang.totalSpinsLabel}: %{value:,.0f}<br>%{percent}<extra></extra>`
    }], {
      ...monthlyChartLayout(title, ''),
      margin: { l: 20, r: 20, t: 48, b: 20 },
      showlegend: false
    }, { responsive: true, displaylogo: false, displayModeBar: false });
    document.getElementById(bodyId).innerHTML = tableTopRows.length ? tableTopRows.map(row => `<tr>
      <td>${escapeHtml(row.parent_agent_name || row.parent_agent_id)}</td><td>${escapeHtml(row.agent_name || row.agent_id)}</td><td>${formatCount(row.player_count)}</td>
      <td>${formatCount(row.total_spin_count)}</td><td>${formatCount(row.total_bet_amount)}</td><td>${formatCount(row.total_win_amount)}</td>
      <td class="${Number(row.ggr || 0) >= 0 ? 'profit-positive' : 'profit-negative'}">${formatCount(row.ggr)}</td>
    </tr>`).join('') : '<tr><td colspan="7">--</td></tr>';
  };
  renderAgentPeriod('home-agent-7d-chart', 'home-agent-7d-body', data.agent_performance?.seven_day || [], lang.homeAgentSevenDayShare);
  renderAgentPeriod('home-agent-day-chart', 'home-agent-day-body', data.agent_performance?.current_day || [], lang.homeAgentCurrentDayShare);
  renderPlayerRows('home-player-7d-body', data.player_alerts?.seven_day || [], sevenDayStart, referenceDate);
  renderPlayerRows('home-player-day-body', data.player_alerts?.current_day || [], referenceDate, referenceDate);
  homeStatus.textContent = '';
}

function loadHomeDashboard({ silent = false } = {}) {
  if (homeDashboardRequest) return homeDashboardRequest;
  if (!silent) homeStatus.textContent = translations[currentLang].homeLoading;
  homeDashboardRequest = (async () => {
    try {
      const response = await fetch('/api/home-dashboard');
      const data = await response.json();
      if (!response.ok) throw new Error(translations[currentLang].apiRequestFailed);
      homeDashboardCache = data;
      homeDashboardLoadedAt = Date.now();
      renderHomeDashboard(data);
    } catch (error) {
      homeStatus.textContent = translations[currentLang].homeLoadError.replace('{message}', error.message);
    } finally {
      homeDashboardRequest = null;
    }
  })();
  return homeDashboardRequest;
}

function startHomeAutoRefresh() {
  if (homeRefreshTimer !== null) return;
  homeRefreshTimer = window.setInterval(() => {
    if (document.hidden || document.body.classList.contains('auth-locked') || homeContent.hidden) return;
    loadHomeDashboard({ silent: true });
  }, HOME_REFRESH_INTERVAL_MS);
}

function populateAgentSelect() {
  const parentValue = agentParentSelect.value;
  const currentValue = agentSelect.value;
  const rows = parentValue === 'ALL' ? [] : agentOptionRows.filter(row => String(row.parent_agent_id) === parentValue);
  const agents = [...new Map(rows.map(row => [String(row.agent_id), row])).values()];
  const agentIds = agents.map(row => String(row.agent_id));
  agentSelect.innerHTML = `<option value="ALL">${translations[currentLang].agentAll}</option>`;
  agents.forEach(row => {
    const agentId = String(row.agent_id);
    const option = document.createElement('option');
    option.value = agentId;
    option.textContent = row.agent_name || agentId;
    agentSelect.appendChild(option);
  });
  agentSelect.value = agentIds.includes(currentValue) ? currentValue : 'ALL';
  updateAgentFilterVisibility();
}

function updateAgentFilterVisibility() {
  const parentSelected = agentParentSelect.value !== 'ALL';
  const agentSelected = parentSelected && agentSelect.value !== 'ALL';
  agentLabelAgent.hidden = !parentSelected;
  agentSelect.hidden = !parentSelected;
  agentGameLabel.hidden = !agentSelected;
  agentGameSelect.hidden = !agentSelected;
  if (!parentSelected) {
    agentSelect.value = 'ALL';
  }
  if (!agentSelected) agentGameSelect.value = 'ALL';
}

async function initializeAgentPage() {
  if (agentInitialized) return;
  agentInitialized = true;
  try {
    const [datesResponse, optionsResponse] = await Promise.all([fetch('/api/agent-dates'), fetch('/api/agent-options')]);
    const dates = await datesResponse.json();
    const options = await optionsResponse.json();
    if (!datesResponse.ok) throw new Error(translations[currentLang].apiRequestFailed);
    if (!optionsResponse.ok) throw new Error(translations[currentLang].apiRequestFailed);
    if (dates.length && (!gameLatestAvailableDate || dates[0] > gameLatestAvailableDate)) {
      gameLatestAvailableDate = dates[0];
    }
    agentOptionRows = options.agents || [];
    agentParentSelect.innerHTML = `<option value="ALL">${translations[currentLang].agentAll}</option>`;
    (options.parent_agents || []).forEach(parentId => {
      const option = document.createElement('option');
      option.value = String(parentId);
      const parentRow = agentOptionRows.find(row => String(row.parent_agent_id) === String(parentId));
      option.textContent = parentRow?.parent_agent_name || String(parentId);
      agentParentSelect.appendChild(option);
    });
    const savedAgent = restoredUiState?.agent || {};
    if (Array.from(agentParentSelect.options).some(option => option.value === String(savedAgent.parentAgentId))) {
      agentParentSelect.value = String(savedAgent.parentAgentId);
    }
    populateAgentSelect();
    if (Array.from(agentSelect.options).some(option => option.value === String(savedAgent.agentId))) {
      agentSelect.value = String(savedAgent.agentId);
    }
    if (!agentEndDate.value && dates.length) {
      agentEndDate.value = dates[0];
      agentStartDate.value = dates[Math.min(6, dates.length - 1)];
    }
    await loadAgentAnalysis();
  } catch (error) {
    agentInitialized = false;
    agentStatus.textContent = translations[currentLang].agentLoadError.replace('{message}', error.message);
  }
}

function aggregateAgentRows(rows, keyFor, labelFor) {
  const grouped = new Map();
  rows.forEach(row => {
    const key = keyFor(row);
    if (!grouped.has(key)) grouped.set(key, {
      key, label: labelFor(row), parent_agent_id: row.parent_agent_id, agent_id: row.agent_id,
      date: row.date, spin_count: 0, total_bet_amount: 0, total_win_amount: 0, ggr: 0
    });
    const target = grouped.get(key);
    ['spin_count', 'total_bet_amount', 'total_win_amount', 'ggr'].forEach(field => {
      target[field] += Number(row[field] || 0);
    });
  });
  return Array.from(grouped.values());
}

function makeAgentRowsInteractive(body, rows, activate, labelFor) {
  Array.from(body.rows).forEach((tableRow, index) => {
    const row = rows[index];
    tableRow.classList.add('home-ranking-link-row');
    tableRow.tabIndex = 0;
    tableRow.setAttribute('role', 'link');
    tableRow.title = labelFor(row);
    const open = () => activate(row);
    tableRow.addEventListener('click', open);
    tableRow.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
  });
}

async function loadAgentGamePerformance(slotId) {
  const requestId = ++agentGamePerformanceRequestId;
  const params = new URLSearchParams({
    parent_agent_id: agentParentSelect.value,
    agent_id: agentSelect.value,
    slot_id: slotId,
    start_date: agentStartDate.value,
    end_date: agentEndDate.value
  });
  agentStatus.textContent = translations[currentLang].agentLoading;
  try {
    const response = await fetch(`/api/agent-game-performance?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(translations[currentLang].apiRequestFailed);
    if (requestId !== agentGamePerformanceRequestId || agentGameSelect.value !== String(slotId)) return;
    renderAgentGamePerformance(payload);
    agentStatus.textContent = translations[currentLang].agentLoaded;
  } catch (error) {
    if (requestId !== agentGamePerformanceRequestId) return;
    agentStatus.textContent = translations[currentLang].agentLoadError.replace('{message}', error.message);
  }
}

function retentionPercentIfAvailable(row, field, dayOffset, latestAvailableDate) {
  const value = row?.[field];
  const dnu = Number(row?.dnu);
  if (!Number.isFinite(dnu) || dnu <= 0) return null;
  if (!row?.date || !latestAvailableDate) return null;
  const observationDate = shiftGameDate(row.date, dayOffset);
  if (observationDate >= latestAvailableDate) return null;
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number * 100 : null;
}

function matureRetentionPercent(row, field, dayOffset) {
  return retentionPercentIfAvailable(row, field, dayOffset, gameLatestAvailableDate);
}

function monthlyRetentionPercent(row, field, dayOffset) {
  return retentionPercentIfAvailable(row, field, dayOffset, monthlyLatestAvailableDate);
}

function retentionBarItems(row) {
  return [
    { label: 'D1', value: matureRetentionPercent(row, 'retention_1', 1), color: '#10b981' },
    { label: 'D3', value: matureRetentionPercent(row, 'retention_3', 3), color: '#f59e0b' },
    { label: 'D7', value: matureRetentionPercent(row, 'retention_7', 7), color: '#ef4444' }
  ].filter(item => item.value !== null);
}

function sortDetailRows(rows, sortState) {
  return [...rows].sort((a, b) => {
    const left = a[sortState.key];
    const right = b[sortState.key];
    const stringKeys = new Set(['date', 'label', 'game_name', 'bet_type_label']);
    const result = stringKeys.has(sortState.key)
      ? String(left ?? '').localeCompare(String(right ?? ''), activeLocale(), { numeric: true })
      : Number(left || 0) - Number(right || 0);
    return sortState.direction === 'asc' ? result : -result;
  });
}

function updateDetailSortHeaders(selector, sortState) {
  document.querySelectorAll(selector).forEach(button => {
    const key = button.dataset.gameDetailKey || button.dataset.agentDetailKey || button.dataset.agentGameDetailKey;
    const baseLabel = button.dataset.label || button.textContent.replace(/\s[▲▼]$/, '');
    button.dataset.label = baseLabel;
    const active = key === sortState.key;
    button.classList.toggle('active', active);
    button.textContent = `${baseLabel}${active ? ` ${sortState.direction === 'asc' ? '▲' : '▼'}` : ''}`;
  });
}

function toggleDetailSort(sortState, key) {
  return sortState.key === key
    ? { key, direction: sortState.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: key === 'date' || key.endsWith('label') ? 'asc' : 'desc' };
}

function renderAgentGamePerformance(payload) {
  agentGamePerformanceCache = payload;
  const rows = payload.rows || [];
  const hourlyPlayers = payload.hourly_players || [];
  const medianByDate = new Map((payload.medians || []).map(row => [row.date, row.median_player_spin_count]));
  const data = rows.map(row => ({ ...row, median_player_spin_count: medianByDate.get(row.date) ?? null }));
  const lang = translations[currentLang];
  const common = { responsive: true, displaylogo: false, displayModeBar: false };
  const dates = data.map(row => row.date);
  const singleDay = agentStartDate.value === agentEndDate.value;
  const total = key => data.reduce((sum, row) => sum + Number(row[key] || 0), 0);
  const average = key => data.length ? total(key) / data.length : 0;
  const totalBet = total('total_bet_amount');
  const totalWin = total('total_win_amount');

  document.getElementById('agent-game-avg-players').textContent = formatCount(average('player_count'));
  document.getElementById('agent-game-avg-dnu').textContent = formatCount(average('dnu'));
  document.getElementById('agent-game-avg-rtp').textContent = `${(totalBet ? totalWin / totalBet * 100 : 0).toFixed(2)}%`;
  document.getElementById('agent-game-total-spins').textContent = formatCount(total('total_spin_count'));
  document.getElementById('agent-game-total-bet').textContent = formatCount(totalBet);
  document.getElementById('agent-game-total-win').textContent = formatCount(totalWin);
  document.getElementById('agent-game-total-ggr').textContent = formatCount(totalBet - totalWin);
  document.getElementById('agent-game-days').textContent = formatCount(data.length);

  Plotly.newPlot('agent-game-player-chart', [{
    x: dates, y: data.map(row => Number(row.player_count || 0)), name: lang.axisPlayers,
    type: 'scatter', mode: 'lines+markers', line: { color: '#38bdf8', width: 3 }
  }], monthlyChartLayout(lang.chartGamePlayers, lang.axisPlayers), common);
  Plotly.newPlot('agent-game-ggr-chart', [{
    x: dates, y: data.map(row => Number(row.total_bet_amount || 0) - Number(row.total_win_amount || 0)),
    name: 'GGR', type: 'bar', marker: { color: data.map(row => Number(row.total_bet_amount || 0) - Number(row.total_win_amount || 0) >= 0 ? '#10b981' : '#ef4444') }
  }], monthlyChartLayout(lang.chartGameGgr, lang.axisGgr), common);

  document.getElementById('agent-game-dau-dnu-panel').hidden = singleDay;
  document.getElementById('agent-game-rtp-panel').hidden = singleDay;
  if (!singleDay) {
    Plotly.newPlot('agent-game-dau-dnu-chart', [
      { x: dates, y: data.map(row => Number(row.player_count || 0)), name: 'DAU', type: 'scatter', mode: 'lines+markers', line: { color: '#38bdf8', width: 3 } },
      { x: dates, y: data.map(row => Number(row.dnu || 0)), name: 'DNU', type: 'scatter', mode: 'lines+markers', line: { color: '#ff5a1f', width: 2 } }
    ], monthlyChartLayout(lang.chartGameDauDnu, lang.axisPlayers), common);
    Plotly.newPlot('agent-game-rtp-chart', [{
      x: dates, y: data.map(row => Number(row.rtp || 0) * 100), name: 'RTP', type: 'scatter', mode: 'lines+markers', line: { color: '#6366f1', width: 3 }
    }], monthlyChartLayout(lang.chartGameRtp, lang.axisRtp, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
    Plotly.newPlot('agent-game-retention-chart', [
      { x: dates, y: data.map(row => matureRetentionPercent(row, 'retention_1', 1)), name: 'D1', type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: '#10b981' } },
      { x: dates, y: data.map(row => matureRetentionPercent(row, 'retention_3', 3)), name: 'D3', type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: '#f59e0b' } },
      { x: dates, y: data.map(row => matureRetentionPercent(row, 'retention_7', 7)), name: 'D7', type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: '#ef4444' } }
    ], monthlyChartLayout(lang.chartGameRetention, lang.axisRetention, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
  } else {
    const day = data[0] || {};
    const retentionBars = retentionBarItems(day);
    Plotly.newPlot('agent-game-retention-chart', [{
      x: retentionBars.map(item => item.label), y: retentionBars.map(item => item.value),
      type: 'bar', marker: { color: retentionBars.map(item => item.color) }, showlegend: false
    }], monthlyChartLayout(lang.chartGameRetention, lang.axisRetention, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
  }

  Plotly.newPlot('agent-game-bet-type-chart', [
    { x: hourlyPlayers.map(row => row.hour), y: hourlyPlayers.map(row => Number(row.bet_1_player_count || 0)), name: lang.betTypeNormal, type: 'scatter', mode: 'lines+markers', line: { color: '#6366f1' } },
    { x: hourlyPlayers.map(row => row.hour), y: hourlyPlayers.map(row => Number(row.bet_2_player_count || 0)), name: lang.betTypeAnte, type: 'scatter', mode: 'lines+markers', line: { color: '#f59e0b' } },
    { x: hourlyPlayers.map(row => row.hour), y: hourlyPlayers.map(row => Number(row.bet_3_player_count || 0)), name: lang.betTypeBuy, type: 'scatter', mode: 'lines+markers', line: { color: '#10b981' } }
  ], monthlyChartLayout(singleDay ? lang.chartGameHourlyBetTypePlayers : lang.chartGameHourlyBetTypePlayersAverage, lang.axisPlayers, { xaxis: { dtick: 2 } }), common);

  renderGameSpinDistribution(data, 'agent-game-spin-distribution-chart');
  const betTypes = [
    { id: 1, label: lang.betTypeNormal },
    { id: 2, label: lang.betTypeAnte },
    { id: 3, label: lang.betTypeBuy }
  ];
  const detailRows = data.flatMap(row => betTypes.map(betType => {
    const prefix = `bet_${betType.id}`;
    const bet = Number(row[`${prefix}_total_bet_amount`] || 0);
    const win = Number(row[`${prefix}_total_win_amount`] || 0);
    return {
      date: row.date, bet_type_label: betType.label,
      player_count: Number(row[`${prefix}_player_count`] || 0), spin_count: Number(row[`${prefix}_spin_count`] || 0),
      bet_amount: bet, win_amount: win, rtp: bet ? win / bet * 100 : 0, ggr: bet - win
    };
  }));
  updateDetailSortHeaders('[data-agent-game-detail-key]', agentGameDetailSort);
  document.getElementById('agent-game-daily-bet-body').innerHTML = sortDetailRows(detailRows, agentGameDetailSort).map(row =>
    `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.bet_type_label)}</td>
      <td>${formatCount(row.player_count)}</td><td>${formatCount(row.spin_count)}</td>
      <td>${formatCount(row.bet_amount)}</td><td>${formatCount(row.win_amount)}</td><td>${row.rtp.toFixed(2)}%</td><td>${formatCount(row.ggr)}</td></tr>`
  ).join('') || '<tr><td colspan="8" class="table-empty-message">--</td></tr>';
}

function renderAgentAnalysis(data) {
  const lang = translations[currentLang];
  agentAnalysisCache = data;
  const cube = data.cube || [];
  const details = data.details || [];
  const games = data.games || [];
  const gameDetails = data.game_details || [];
  const parentSelected = agentParentSelect.value !== 'ALL';
  const agentSelected = parentSelected && agentSelect.value !== 'ALL';
  const selectedGameId = agentSelected ? agentGameSelect.value : 'ALL';
  const selectedGame = selectedGameId === 'ALL'
    ? null
    : games.find(row => String(row.slot_id) === selectedGameId);
  const selectedGameName = formatGameNameOnly(selectedGame?.slot_id || selectedGameId, selectedGame?.game_name);
  const common = { responsive: true, displaylogo: false, displayModeBar: false };
  let chartRows;
  let spinTitle;
  let ggrTitle;

  if (!parentSelected) {
    chartRows = aggregateAgentRows(cube, row => String(row.parent_agent_id), row => row.parent_agent_name || row.parent_agent_id);
    spinTitle = lang.parentAgentSpinShare;
    ggrTitle = lang.parentAgentGgr;
  } else if (!agentSelected) {
    chartRows = cube.map(row => ({ ...row, label: row.agent_name || row.agent_id }));
    spinTitle = lang.agentSpinShareTopFive;
    ggrTitle = lang.agentGgr;
  } else {
    if (selectedGame) {
      chartRows = gameDetails
        .filter(row => String(row.slot_id) === selectedGameId)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(row => ({ ...row, label: row.date }));
      const context = `${agentParentSelect.options[agentParentSelect.selectedIndex]?.text || agentParentSelect.value} / ${agentSelect.options[agentSelect.selectedIndex]?.text || agentSelect.value} / ${selectedGameName}`;
      spinTitle = lang.dailyTotalSpins.replace('{context}', context);
      ggrTitle = lang.dailyGgr.replace('{context}', context);
    } else {
      chartRows = games.map(row => ({ ...row, label: formatGameNameOnly(row.slot_id, row.game_name) }));
      spinTitle = lang.totalSpinsByGame;
      ggrTitle = lang.ggrByGame;
    }
  }

  const ranked = [...chartRows].sort((a, b) => Number(b.spin_count || 0) - Number(a.spin_count || 0));
  if (!agentSelected) {
    let pieRows = ranked;
    if (parentSelected && ranked.length > 5) {
      pieRows = [...ranked.slice(0, 5), {
        label: lang.other,
        spin_count: ranked.slice(5).reduce((sum, row) => sum + Number(row.spin_count || 0), 0)
      }];
    }
    Plotly.newPlot('agent-spin-chart', [{
      labels: pieRows.map(row => row.label), values: pieRows.map(row => Number(row.spin_count || 0)),
      type: 'pie', hole: 0.42, textinfo: 'label+percent',
      hovertemplate: `%{label}<br>${lang.totalSpinsLabel}: %{value:,.0f}<br>%{percent}<extra></extra>`
    }], { ...monthlyChartLayout(spinTitle, ''), margin: { l: 20, r: 20, t: 48, b: 20 }, showlegend: false }, common);
  } else {
    const barRows = selectedGame ? chartRows : ranked;
    Plotly.newPlot('agent-spin-chart', [{
      x: barRows.map(row => row.label), y: barRows.map(row => Number(row.spin_count || 0)), type: 'bar',
      marker: { color: '#6366f1' }, hovertemplate: `%{x}<br>${lang.totalSpinsLabel}: %{y:,.0f}<extra></extra>`
    }], monthlyChartLayout(spinTitle, lang.totalSpinsLabel, { xaxis: { automargin: true } }), common);
  }
  Plotly.newPlot('agent-ggr-chart', [{
    x: chartRows.map(row => row.label), y: chartRows.map(row => Number(row.ggr || 0)), type: 'bar',
    marker: { color: chartRows.map(row => Number(row.ggr || 0) >= 0 ? '#10b981' : '#ef4444') },
    hovertemplate: '%{x}<br>GGR: %{y:,.0f} IDR<extra></extra>'
  }], monthlyChartLayout(ggrTitle, 'GGR (IDR)', { xaxis: { automargin: true } }), common);

  const gamePanel = document.getElementById('agent-game-summary-panel');
  gamePanel.hidden = !parentSelected || agentSelected;
  if (!gamePanel.hidden) {
    document.getElementById('agent-game-summary-body').innerHTML = games.length ? games.map(row => `<tr>
      <td>${escapeHtml(formatGameNameOnly(row.slot_id, row.game_name))}</td><td>${formatCount(row.spin_count)}</td>
      <td>${formatCount(row.total_bet_amount)}</td><td>${formatCount(row.total_win_amount)}</td><td>${formatCount(row.ggr)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="table-empty-message">--</td></tr>';
  }

  agentGameSelect.innerHTML = `<option value="ALL">${translations[currentLang].agentAllGames}</option>`;
  games.forEach(row => {
    const option = document.createElement('option');
    option.value = String(row.slot_id);
    option.textContent = formatGameDisplay(row.slot_id, row.game_name);
    agentGameSelect.appendChild(option);
  });
  if (Array.from(agentGameSelect.options).some(option => option.value === selectedGameId)) {
    agentGameSelect.value = selectedGameId;
  }
  const showScopedGamePerformance = Boolean(agentSelected && selectedGame);
  document.getElementById('agent-overview-charts').hidden = showScopedGamePerformance;
  document.getElementById('agent-details-panel').hidden = showScopedGamePerformance;
  document.getElementById('agent-game-performance').hidden = !showScopedGamePerformance;

  const detailsHead = document.getElementById('agent-details-head');
  const detailsBody = document.getElementById('agent-details-body');
  let displayRows;
  if (agentSelected) {
    document.getElementById('agent-details-title').textContent = selectedGame
      ? lang.gameDailyDetails.replace('{game}', selectedGameName)
      : lang.allGameDetails;
    detailsHead.innerHTML = `<tr><th><button type="button" data-agent-detail-key="date">${lang.date}</button></th><th><button type="button" data-agent-detail-key="label">${lang.agentGame}</button></th><th><button type="button" data-agent-detail-key="spin_count">${lang.totalSpinsLabel}</button></th><th><button type="button" data-agent-detail-key="total_bet_amount">${lang.totalBet}</button></th><th><button type="button" data-agent-detail-key="total_win_amount">${lang.totalWin}</button></th><th><button type="button" data-agent-detail-key="ggr">GGR</button></th></tr>`;
    displayRows = gameDetails
      .filter(row => !selectedGame || String(row.slot_id) === selectedGameId)
      .map(row => ({ ...row, label: formatGameNameOnly(row.slot_id, row.game_name) }));
    displayRows = sortDetailRows(displayRows, agentDetailSort);
    updateDetailSortHeaders('[data-agent-detail-key]', agentDetailSort);
    detailsBody.innerHTML = displayRows.length ? displayRows.map(row => `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.label)}</td>
      <td>${formatCount(row.spin_count)}</td><td>${formatCount(row.total_bet_amount)}</td><td>${formatCount(row.total_win_amount)}</td><td>${formatCount(row.ggr)}</td></tr>`).join('') : '<tr><td colspan="6" class="table-empty-message">--</td></tr>';
    if (displayRows.length && !selectedGame) makeAgentRowsInteractive(detailsBody, displayRows, row => {
      agentGameSelect.value = String(row.slot_id);
      renderAgentAnalysis(agentAnalysisCache);
      saveUiState();
    }, row => lang.selectGame.replace('{game}', formatGameNameOnly(row.slot_id, row.game_name)));
  } else {
    const keyFor = parentSelected
      ? row => `${row.date}|${row.agent_id}`
      : row => `${row.date}|${row.parent_agent_id}`;
    const labelFor = parentSelected
      ? row => row.agent_name || row.agent_id
      : row => row.parent_agent_name || row.parent_agent_id;
    displayRows = sortDetailRows(aggregateAgentRows(details, keyFor, labelFor), agentDetailSort);
    const entityHeading = parentSelected ? lang.agentLabel : lang.agentParent;
    document.getElementById('agent-details-title').textContent = parentSelected
      ? lang.agentDailyDetails : lang.parentAgentDailyDetails;
    detailsHead.innerHTML = `<tr><th><button type="button" data-agent-detail-key="date">${lang.date}</button></th><th><button type="button" data-agent-detail-key="label">${entityHeading}</button></th><th><button type="button" data-agent-detail-key="spin_count">${lang.totalSpinsLabel}</button></th><th><button type="button" data-agent-detail-key="total_bet_amount">${lang.totalBet}</button></th><th><button type="button" data-agent-detail-key="total_win_amount">${lang.totalWin}</button></th><th><button type="button" data-agent-detail-key="ggr">GGR</button></th></tr>`;
    updateDetailSortHeaders('[data-agent-detail-key]', agentDetailSort);
    detailsBody.innerHTML = displayRows.length ? displayRows.map(row => `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(String(row.label))}</td>
      <td>${formatCount(row.spin_count)}</td><td>${formatCount(row.total_bet_amount)}</td><td>${formatCount(row.total_win_amount)}</td><td>${formatCount(row.ggr)}</td></tr>`).join('') : '<tr><td colspan="6" class="table-empty-message">--</td></tr>';
    if (displayRows.length) makeAgentRowsInteractive(detailsBody, displayRows, row => {
      if (!parentSelected) {
        agentParentSelect.value = String(row.parent_agent_id);
        populateAgentSelect();
      } else {
        agentSelect.value = String(row.agent_id);
        updateAgentFilterVisibility();
      }
      loadAgentAnalysis();
    }, row => lang.drillDown.replace('{entity}', row.label));
  }

  agentStatus.textContent = cube.length || details.length
    ? translations[currentLang].agentLoaded
    : translations[currentLang].agentNoData;
  if (showScopedGamePerformance) loadAgentGamePerformance(selectedGameId);
  else agentGamePerformanceRequestId += 1;
}

async function loadAgentAnalysis() {
  if (!agentStartDate.value || !agentEndDate.value) return;
  agentStatus.textContent = translations[currentLang].agentLoading;
  const params = new URLSearchParams({
    parent_agent_id: agentParentSelect.value,
    agent_id: agentSelect.value,
    bet_type: 'ALL',
    start_date: agentStartDate.value,
    end_date: agentEndDate.value
  });
  try {
    const response = await fetch(`/api/agent-analysis?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(translations[currentLang].apiRequestFailed);
    renderAgentAnalysis(data);
    saveUiState();
  } catch (error) {
    agentStatus.textContent = translations[currentLang].agentLoadError.replace('{message}', error.message);
  }
}

function setMonthlyMode() {
  const mode = monthlyModeSelect.value;
  const comparing = mode === 'compare';
  const periodMode = mode === 'quarter' || mode === 'half-year' || mode === 'year';
  monthlySingleControls.hidden = mode === 'compare';
  btnMonthlyPrevious.hidden = mode !== 'single';
  btnMonthlyNext.hidden = mode !== 'single';
  monthlyCompareControls.hidden = mode !== 'compare';
  monthlyBetTypePanel.hidden = comparing;
  monthlyDnuPanel.hidden = !comparing;
  monthlyRetention3Panel.hidden = !comparing;
  monthlyRetention7Panel.hidden = !comparing;
  monthlyContent.classList.toggle('monthly-period-mode', periodMode);
  monthlyContent.classList.toggle('monthly-cube-zoom-enabled', mode === 'single' || mode === 'compare');
  clearExpandedMonthlyCube();
  document.getElementById('monthly-label-month').textContent = periodMode
    ? translations[currentLang].labelPeriodEndMonth
    : translations[currentLang].labelAnalysisMonth;
  if (comparing && !monthlyEndMonth.value && monthlyMonthSelect.value) {
    monthlyEndMonth.value = monthlyMonthSelect.value;
    monthlyStartMonth.value = shiftMonth(monthlyMonthSelect.value, -5);
  }
}

function setActivePage(page) {
  const isHome = page === 'home';
  const isMonthly = page === 'monthly';
  const isGame = page === 'game';
  const isAgent = page === 'agent';
  const isSinglePlayer = page === 'single-player';
  const isPlayer = page === 'player';
  document.querySelector('main').classList.toggle('home-page', isHome);
  document.querySelector('main').classList.toggle('monthly-page', isMonthly);
  document.querySelector('main').classList.toggle('game-page', isGame);
  document.querySelector('main').classList.toggle('agent-page', isAgent);
  document.querySelector('main').classList.toggle('single-player-page', isSinglePlayer);
  document.querySelector('main').classList.toggle('player-page', isPlayer);
  homeContent.hidden = !isHome;
  monthlyContent.hidden = !isMonthly;
  gameContent.hidden = !isGame;
  agentContent.hidden = !isAgent;
  singlePlayerContent.hidden = !isSinglePlayer;

  pageNavItems.forEach((item) => {
    const active = item.dataset.page === page;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });

  if (isMonthly && !monthlyMonthSelect.value) {
    loadMonthlyDateDefaults();
  }
  if (isGame && !gameLatestAvailableDate) {
    loadGameDateDefaults();
  }
  if (isHome) loadHomeDashboard();
  if (isAgent) initializeAgentPage();
  if (isSinglePlayer && (!singlePlayerStartDate.value || !singlePlayerEndDate.value)) {
    fetch('/api/dates')
      .then(response => response.json())
      .then(dates => {
        if (!Array.isArray(dates) || !dates.length) return;
        singlePlayerEndDate.value = dates[0];
        singlePlayerStartDate.value = dates[Math.min(6, dates.length - 1)];
      })
      .catch(() => {});
  }
  saveUiState();
}

function monthlyChartLayout(title, yTitle, extra = {}) {
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(248, 250, 252, 0.72)',
    font: { family: 'Roboto Mono, SFMono-Regular, Consolas, monospace', color: '#475569' },
    margin: { l: 55, r: 20, t: 48, b: 45 },
    title: { text: title, font: { color: '#0f172a', size: 15 } },
    xaxis: { gridcolor: 'rgba(15,23,42,0.09)', tickfont: { color: '#475569' } },
    yaxis: { title: yTitle, gridcolor: 'rgba(15,23,42,0.09)', tickfont: { color: '#475569' } },
    legend: { font: { color: '#475569' }, bgcolor: 'rgba(255, 255, 255, 0.9)' },
    hovermode: 'x unified',
    ...extra
  };
}

function renderMonthlyCharts(rows) {
  const lang = translations[currentLang];
  const dates = rows.map(row => row.date);
  const dnuColor = '#ff5a1f';
  const pct = value => Number(value || 0) * 100;
  const money = value => Number(value || 0);
  const common = { responsive: true, displaylogo: false, displayModeBar: false };

  Plotly.newPlot('monthly-rtp-chart', [
    { x: dates, y: rows.map(r => pct(r.rtp)), name: 'RTP', type: 'scatter', mode: 'lines+markers', line: { color: '#6366f1', width: 3 } },
    { x: dates, y: rows.map(r => pct(r.odd_rtp)), name: lang.oddRtp, type: 'scatter', mode: 'lines+markers', line: { color: '#f59e0b', width: 2 } }
  ], monthlyChartLayout(lang.chartDailyRtp, lang.axisRtp, {
    margin: { l: 55, r: 20, t: 58, b: 45 },
    legend: { orientation: 'h', x: 0.42, y: 1.15, xanchor: 'left', yanchor: 'top', font: { color: '#475569' }, bgcolor: 'rgba(255, 255, 255, 0.9)' },
    yaxis: { tickformat: '.1f', ticksuffix: '%' }
  }), common);

  Plotly.newPlot('monthly-ggr-chart', [
    { x: dates, y: rows.map(r => money(r.total_bet_amount) - money(r.total_win_amount)), name: 'GGR', type: 'bar', marker: { color: '#10b981' } }
  ], monthlyChartLayout(lang.chartDailyGgr, lang.axisGgr), common);

  Plotly.newPlot('monthly-player-chart', [
    { x: dates, y: rows.map(r => Number(r.player_count || 0)), name: 'DAU', type: 'scatter', mode: 'lines+markers', line: { color: '#38bdf8', width: 3 } },
    { x: dates, y: rows.map(r => Number(r.dnu || 0)), name: 'DNU', type: 'scatter', mode: 'lines+markers', line: { color: dnuColor, width: 2 } }
  ], monthlyChartLayout(lang.chartDauDnu, lang.axisPlayers), common);

  Plotly.newPlot('monthly-dnu-rate-chart', [
    { x: dates, y: rows.map(r => Number(r.player_count || 0) ? Number(r.dnu || 0) / Number(r.player_count) * 100 : 0), name: lang.axisDnuRate, type: 'scatter', mode: 'lines+markers', line: { color: '#facc15', width: 3 } }
  ], monthlyChartLayout(lang.chartDnuRate, lang.axisDnuRate, { yaxis: { ticksuffix: '%', rangemode: 'tozero' } }), common);

  Plotly.newPlot('monthly-retention-chart', [
    { x: dates, y: rows.map(r => monthlyRetentionPercent(r, 'retention_1', 1)), name: 'D1', type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: '#10b981' } },
    { x: dates, y: rows.map(r => monthlyRetentionPercent(r, 'retention_3', 3)), name: 'D3', type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: '#f59e0b' } },
    { x: dates, y: rows.map(r => monthlyRetentionPercent(r, 'retention_7', 7)), name: 'D7', type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: '#ef4444' } }
  ], monthlyChartLayout(lang.chartRetention, lang.axisRetention, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);

  Plotly.newPlot('monthly-bet-type-chart', [
    { x: dates, y: rows.map(r => Number(r.bet_1_player_count || 0)), name: lang.betTypeNormal, type: 'scatter', mode: 'lines', line: { color: '#6366f1' } },
    { x: dates, y: rows.map(r => Number(r.bet_2_player_count || 0)), name: lang.betTypeAnte, type: 'scatter', mode: 'lines', line: { color: '#f59e0b' } },
    { x: dates, y: rows.map(r => Number(r.bet_3_player_count || 0)), name: lang.betTypeBuy, type: 'scatter', mode: 'lines', line: { color: '#10b981' } }
  ], monthlyChartLayout(lang.chartBetTypePlayers, lang.axisPlayers), common);
}

function renderMonthlyComparisonCharts(rows) {
  const lang = translations[currentLang];
  const groups = new Map();
  rows.forEach(row => {
    const month = row.date.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(row);
  });
  const pct = value => Number(value || 0) * 100;
  const money = value => Number(value || 0);
  const colors = ['#6366f1', '#f59e0b', '#10b981', '#38bdf8', '#ef4444', '#a78bfa', '#f472b6', '#14b8a6', '#fb923c', '#84cc16', '#8b5cf6', '#06b6d4'];
  const dnuColors = ['#ff5a1f', '#ec4899', '#eab308', '#f43f5e', '#d946ef', '#f97316', '#be123c', '#c026d3', '#ea580c', '#db2777', '#ca8a04', '#e11d48'];
  const rateColors = ['#fde047', '#bef264', '#67e8f9', '#f0abfc', '#fdba74', '#a7f3d0', '#fda4af', '#c4b5fd', '#fef08a', '#99f6e4', '#fbcfe8', '#bae6fd'];
  const common = { responsive: true, displaylogo: false, displayModeBar: false };
  const traces = (value, type = 'scatter') => Array.from(groups, ([month, monthRows], index) => ({
    x: monthRows.map(row => Number(row.date.slice(8, 10))), y: monthRows.map(value), name: month,
    type, mode: type === 'bar' ? undefined : 'lines+markers',
    line: { color: colors[index], width: 2 }, marker: { color: colors[index] }
  }));
  const layout = (title, axis, extra = {}) => monthlyChartLayout(title, axis, {
    xaxis: { title: lang.dayOfMonth, dtick: 1 }, ...extra
  });
  Plotly.newPlot('monthly-rtp-chart', traces(r => pct(r.rtp)), layout(lang.chartDailyRtp, lang.axisRtp, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
  Plotly.newPlot('monthly-ggr-chart', traces(r => money(r.total_bet_amount) - money(r.total_win_amount), 'bar'), layout(lang.chartDailyGgr, lang.axisGgr, { barmode: 'group' }), common);
  const dauTraces = Array.from(groups, ([month, monthRows], index) => ({
    x: monthRows.map(row => Number(row.date.slice(8, 10))), y: monthRows.map(r => Number(r.player_count || 0)),
    name: month, type: 'scatter', mode: 'lines+markers', line: { color: colors[index], width: 2 }
  }));
  const dnuTraces = Array.from(groups, ([month, monthRows], index) => ({
    x: monthRows.map(row => Number(row.date.slice(8, 10))), y: monthRows.map(r => Number(r.dnu || 0)),
    name: month, type: 'scatter', mode: 'lines+markers', line: { color: dnuColors[index], width: 2 }
  }));
  const dnuRateTraces = Array.from(groups, ([month, monthRows], index) => ({
    x: monthRows.map(row => Number(row.date.slice(8, 10))),
    y: monthRows.map(r => Number(r.player_count || 0) ? Number(r.dnu || 0) / Number(r.player_count) * 100 : 0),
    name: month, type: 'scatter', mode: 'lines+markers', line: { color: rateColors[index], width: 2 }
  }));
  Plotly.newPlot('monthly-player-chart', dauTraces, layout(lang.chartDailyPlayers, lang.axisPlayers), common);
  Plotly.newPlot('monthly-dnu-chart', dnuTraces, layout(lang.chartDailyDnu, lang.axisPlayers), common);
  Plotly.newPlot('monthly-dnu-rate-chart', dnuRateTraces, layout(lang.chartDnuRate, lang.axisDnuRate, { yaxis: { ticksuffix: '%', rangemode: 'tozero' } }), common);
  const retentionLayout = label => layout(`${lang.chartRetention} (${label})`, lang.axisRetention, { yaxis: { tickformat: '.1f', ticksuffix: '%' } });
  Plotly.newPlot('monthly-retention-chart', traces(r => monthlyRetentionPercent(r, 'retention_1', 1)), retentionLayout('D1'), common);
  Plotly.newPlot('monthly-retention-3-chart', traces(r => monthlyRetentionPercent(r, 'retention_3', 3)), retentionLayout('D3'), common);
  Plotly.newPlot('monthly-retention-7-chart', traces(r => monthlyRetentionPercent(r, 'retention_7', 7)), retentionLayout('D7'), common);
}

function updateMonthlyMetrics(rows) {
  const average = key => rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) / rows.length;
  const total = key => rows.reduce((sum, row) => sum + Number(row[key] || 0), 0);
  document.getElementById('monthly-avg-players').textContent = formatCount(average('player_count'));
  document.getElementById('monthly-avg-dnu').textContent = formatCount(average('dnu'));
  document.getElementById('monthly-avg-rtp').textContent = `${(average('rtp') * 100).toFixed(2)}%`;
  document.getElementById('monthly-total-spins').textContent = formatCount(total('total_spin_count'));
  document.getElementById('monthly-total-bet').textContent = formatCount(total('total_bet_amount'));
  document.getElementById('monthly-total-win').textContent = formatCount(total('total_win_amount'));
  document.getElementById('monthly-total-ggr').textContent = formatCount(total('total_bet_amount') - total('total_win_amount'));
  document.getElementById('monthly-days').textContent = formatCount(rows.length);
}

async function loadMonthlyDateDefaults() {
  try {
    const response = await fetch('/api/dates');
    const dates = await response.json();
    if (!Array.isArray(dates) || !dates.length) return;
    const latestDate = dates[0];
    monthlyLatestAvailableDate = latestDate;
    latestAvailableMonth = latestDate.slice(0, 7);
    monthlyMonthSelect.value = latestAvailableMonth;
    monthlyEndMonth.value = monthlyMonthSelect.value;
    monthlyStartMonth.value = shiftMonth(monthlyEndMonth.value, -5);
    loadMonthlyData();
  } catch (error) {
    setLocalizedStatus(monthlyStatus, 'monthlyDateError');
  }
}

async function loadMonthlyData() {
  clearExpandedMonthlyCube();
  const mode = monthlyModeSelect.value;
  const comparing = mode === 'compare';
  const requestedSingleMonth = mode === 'single' ? monthlyMonthSelect.value : '';
  let startRange;
  let endRange;
  if (mode === 'compare') {
    const startIndex = monthIndex(monthlyStartMonth.value);
    const endIndex = monthIndex(monthlyEndMonth.value);
    if (startIndex === null || endIndex === null) return;
    if (startIndex > endIndex) {
      setLocalizedStatus(monthlyStatus, 'monthlyRangeOrderError');
      return;
    }
    if (endIndex - startIndex + 1 > 6) {
      setLocalizedStatus(monthlyStatus, 'monthlyRangeLimitError');
      return;
    }
    startRange = getCalendarMonthRange(monthlyStartMonth.value);
    endRange = getCalendarMonthRange(monthlyEndMonth.value);
  } else if (mode === 'single') {
    startRange = endRange = getCalendarMonthRange(monthlyMonthSelect.value);
  } else {
    const monthCount = mode === 'quarter' ? 3 : mode === 'half-year' ? 6 : 12;
    const endMonth = monthlyMonthSelect.value || latestAvailableMonth;
    if (!endMonth) return;
    monthlyEndMonth.value = endMonth;
    monthlyStartMonth.value = shiftMonth(endMonth, -(monthCount - 1));
    startRange = getCalendarMonthRange(monthlyStartMonth.value);
    endRange = getCalendarMonthRange(endMonth);
  }
  if (!startRange || !endRange) return;
  const startDate = startRange.startDate;
  const endDate = endRange.endDate;
  setLocalizedStatus(monthlyStatus, 'monthlyLoading');
  try {
    if (!monthlyLatestAvailableDate) {
      const datesResponse = await fetch('/api/dates');
      const availableDates = await datesResponse.json();
      if (!datesResponse.ok) throw new Error(translations[currentLang].apiRequestFailed);
      monthlyLatestAvailableDate = Array.isArray(availableDates) ? (availableDates[0] || '') : '';
    }
    const response = await fetch(`/api/monthly?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`);
    const rows = await response.json();
    if (!response.ok) throw new Error(translations[currentLang].apiRequestFailed);
    if (!rows.length) {
      setLocalizedStatus(monthlyStatus, 'monthlyNoData');
      if (requestedSingleMonth) {
        if (lastLoadedMonthlyMonth && lastLoadedMonthlyMonth !== requestedSingleMonth) {
          monthlyMonthSelect.value = lastLoadedMonthlyMonth;
          saveUiState();
        }
        window.alert(translations[currentLang].monthlyMonthNoData.replace('{month}', requestedSingleMonth));
      }
      return;
    }
    if (requestedSingleMonth) lastLoadedMonthlyMonth = requestedSingleMonth;
    monthlyDataCache = rows;
    updateMonthlyMetrics(rows);
    if (comparing) renderMonthlyComparisonCharts(rows);
    else renderMonthlyCharts(rows);
    loadMonthlyGameRanking(startDate, endDate).catch(error => {
      console.error('Failed to load monthly game ranking:', error);
      monthlyGameRankingCache = [];
      renderMonthlyGameRanking();
    });
    setLocalizedStatus(monthlyStatus, 'monthlyLoaded', { start: startDate, end: endDate, days: rows.length });
  } catch (error) {
    setLocalizedStatus(monthlyStatus, 'monthlyLoadError', { message: error.message });
  }
}

function aggregateGameRows(rows) {
  const grouped = new Map();
  rows.forEach(row => {
    const key = row.date;
    if (!grouped.has(key)) {
      grouped.set(key, {
        date: key, player_count: 0, dnu: 0, total_spin_count: 0,
        total_bet_amount: 0, total_win_amount: 0,
        bet_1_player_count: 0, bet_2_player_count: 0, bet_3_player_count: 0,
        retention_1: 0, retention_3: 0, retention_7: 0,
        retention_1_count: 0, retention_3_count: 0, retention_7_count: 0
      });
    }
    const target = grouped.get(key);
    ['player_count', 'dnu', 'total_spin_count', 'total_bet_amount', 'total_win_amount',
      'bet_1_player_count', 'bet_2_player_count', 'bet_3_player_count'].forEach(field => {
      target[field] += Number(row[field] || 0);
    });
    ['retention_1', 'retention_3', 'retention_7'].forEach(field => {
      const value = row[field];
      if (Number(row.dnu) <= 0) return;
      if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return;
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      target[field] += number;
      target[`${field}_count`] += 1;
    });
  });
  return Array.from(grouped.values()).sort((a, b) => a.date.localeCompare(b.date)).map(row => ({
    ...row,
    retention_1: row.retention_1_count ? row.retention_1 / row.retention_1_count : null,
    retention_3: row.retention_3_count ? row.retention_3 / row.retention_3_count : null,
    retention_7: row.retention_7_count ? row.retention_7 / row.retention_7_count : null,
    rtp: row.total_bet_amount ? row.total_win_amount / row.total_bet_amount : 0
  }));
}

function renderGameCharts(rows, selectedSlot, hourlyPlayers = []) {
  const lang = translations[currentLang];
  const data = selectedSlot === 'ALL' ? aggregateGameRows(rows) : rows;
  const dates = data.map(row => row.date);
  const singleDay = gameStartDate.value === gameEndDate.value;
  const pct = value => Number(value || 0) * 100;
  const common = { responsive: true, displaylogo: false, displayModeBar: false };
  gameDauDnuPanel.hidden = singleDay;
  gameRtpPanel.hidden = singleDay;
  gameRetentionPanel.hidden = false;

  if (selectedSlot === 'ALL') {
    const spinByGame = new Map();
    rows.forEach(row => {
      const key = String(row.slot_id);
      if (!spinByGame.has(key)) spinByGame.set(key, { name: formatGameNameOnly(row.slot_id, row.game_name), spins: 0 });
      spinByGame.get(key).spins += Number(row.total_spin_count || 0);
    });
    const rankedGames = Array.from(spinByGame.values()).sort((a, b) => b.spins - a.spins);
    const topGames = rankedGames.slice(0, 10);
    const otherSpins = rankedGames.slice(10).reduce((sum, game) => sum + game.spins, 0);
    if (otherSpins > 0) topGames.push({ name: lang.otherGames, spins: otherSpins });
    Plotly.newPlot('game-player-chart', [{ labels: topGames.map(game => game.name), values: topGames.map(game => game.spins), type: 'pie', textinfo: 'label+percent', hovertemplate: `%{label}<br>${lang.totalSpinsLabel}: %{value:,.0f}<br>%{percent}<extra></extra>`, hole: 0.35 }], monthlyChartLayout(lang.chartGameSpinShare, ''), common);
  } else {
    Plotly.newPlot('game-player-chart', [{ x: dates, y: data.map(r => Number(r.player_count || 0)), name: lang.axisPlayers, type: 'scatter', mode: 'lines+markers', line: { color: '#38bdf8', width: 3 } }], monthlyChartLayout(lang.chartGamePlayers, lang.axisPlayers), common);
  }
  if (singleDay) {
    Plotly.newPlot('game-ggr-chart', [{
      x: rows.map(row => formatGameNameOnly(row.slot_id, row.game_name)),
      y: rows.map(row => Number(row.total_bet_amount || 0) - Number(row.total_win_amount || 0)),
      name: 'GGR', type: 'bar',
      marker: { color: rows.map(row => Number(row.total_bet_amount || 0) - Number(row.total_win_amount || 0) >= 0 ? '#10b981' : '#ef4444') }
    }], monthlyChartLayout(lang.chartGameGgrByGame, lang.axisGgr, { xaxis: { automargin: true } }), common);
  } else {
    Plotly.newPlot('game-ggr-chart', [{ x: dates, y: data.map(r => Number(r.total_bet_amount || 0) - Number(r.total_win_amount || 0)), name: 'GGR', type: 'bar', marker: { color: '#10b981' } }], monthlyChartLayout(lang.chartGameGgr, lang.axisGgr), common);
    Plotly.newPlot('game-dau-dnu-chart', [
      { x: dates, y: data.map(r => Number(r.player_count || 0)), name: 'DAU', type: 'scatter', mode: 'lines+markers', line: { color: '#38bdf8', width: 3 } },
      { x: dates, y: data.map(r => Number(r.dnu || 0)), name: 'DNU', type: 'scatter', mode: 'lines+markers', line: { color: '#ff5a1f', width: 2 } }
    ], monthlyChartLayout(lang.chartGameDauDnu, lang.axisPlayers), common);
  }
  if (singleDay) {
    const day = data[0] || {};
    const retentionBars = retentionBarItems(day);
    Plotly.newPlot('game-retention-chart', [{
      x: retentionBars.map(item => item.label), y: retentionBars.map(item => item.value),
      type: 'bar', marker: { color: retentionBars.map(item => item.color) }, showlegend: false
    }], monthlyChartLayout(lang.chartGameRetention, lang.axisRetention, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
    Plotly.newPlot('game-bet-type-chart', [
      { x: hourlyPlayers.map(r => r.hour), y: hourlyPlayers.map(r => Number(r.bet_1_player_count || 0)), name: lang.betTypeNormal, type: 'scatter', mode: 'lines+markers', line: { color: '#6366f1' } },
      { x: hourlyPlayers.map(r => r.hour), y: hourlyPlayers.map(r => Number(r.bet_2_player_count || 0)), name: lang.betTypeAnte, type: 'scatter', mode: 'lines+markers', line: { color: '#f59e0b' } },
      { x: hourlyPlayers.map(r => r.hour), y: hourlyPlayers.map(r => Number(r.bet_3_player_count || 0)), name: lang.betTypeBuy, type: 'scatter', mode: 'lines+markers', line: { color: '#10b981' } }
    ], monthlyChartLayout(lang.chartGameHourlyBetTypePlayers, lang.axisPlayers, { xaxis: { dtick: 2 } }), common);
  } else {
    Plotly.newPlot('game-rtp-chart', [{ x: dates, y: data.map(r => pct(r.rtp)), name: 'RTP', type: 'scatter', mode: 'lines+markers', line: { color: '#6366f1', width: 3 } }], monthlyChartLayout(lang.chartGameRtp, lang.axisRtp, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
    Plotly.newPlot('game-retention-chart', [
      { x: dates, y: data.map(r => matureRetentionPercent(r, 'retention_1', 1)), name: 'D1', type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: '#10b981' } },
      { x: dates, y: data.map(r => matureRetentionPercent(r, 'retention_3', 3)), name: 'D3', type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: '#f59e0b' } },
      { x: dates, y: data.map(r => matureRetentionPercent(r, 'retention_7', 7)), name: 'D7', type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: '#ef4444' } }
    ], monthlyChartLayout(lang.chartGameRetention, lang.axisRetention, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
    Plotly.newPlot('game-bet-type-chart', [
      { x: hourlyPlayers.map(r => r.hour), y: hourlyPlayers.map(r => Number(r.bet_1_player_count || 0)), name: lang.betTypeNormal, type: 'scatter', mode: 'lines+markers', line: { color: '#6366f1' } },
      { x: hourlyPlayers.map(r => r.hour), y: hourlyPlayers.map(r => Number(r.bet_2_player_count || 0)), name: lang.betTypeAnte, type: 'scatter', mode: 'lines+markers', line: { color: '#f59e0b' } },
      { x: hourlyPlayers.map(r => r.hour), y: hourlyPlayers.map(r => Number(r.bet_3_player_count || 0)), name: lang.betTypeBuy, type: 'scatter', mode: 'lines+markers', line: { color: '#10b981' } }
    ], monthlyChartLayout(lang.chartGameHourlyBetTypePlayersAverage, lang.axisPlayers, { xaxis: { dtick: 2 } }), common);
  }
}

function updateGameMetrics(rows, selectedSlot) {
  const data = selectedSlot === 'ALL' ? aggregateGameRows(rows) : rows;
  const average = key => data.reduce((sum, row) => sum + Number(row[key] || 0), 0) / data.length;
  const total = key => data.reduce((sum, row) => sum + Number(row[key] || 0), 0);
  const totalBet = total('total_bet_amount');
  const totalWin = total('total_win_amount');
  const weightedRtp = totalBet ? totalWin / totalBet : 0;
  document.getElementById('game-avg-players').textContent = formatCount(average('player_count'));
  document.getElementById('game-avg-dnu').textContent = formatCount(average('dnu'));
  document.getElementById('game-avg-rtp').textContent = `${(weightedRtp * 100).toFixed(2)}%`;
  document.getElementById('game-total-spins').textContent = formatCount(total('total_spin_count'));
  document.getElementById('game-total-bet').textContent = formatCount(totalBet);
  document.getElementById('game-total-win').textContent = formatCount(totalWin);
  document.getElementById('game-total-ggr').textContent = formatCount(totalBet - totalWin);
  document.getElementById('game-days').textContent = formatCount(data.length);
}

function renderGameDailyBetStats(rows, selectedSlot, comparisonRows = [], comparisonSlot = '') {
  gameDailyBetPanel.hidden = selectedSlot === 'ALL' || !rows.length;
  if (gameDailyBetPanel.hidden) {
    gameDailyBetBody.innerHTML = '';
    return;
  }

  const lang = translations[currentLang];
  const betTypes = [
    { id: 1, label: lang.betTypeNormal },
    { id: 2, label: lang.betTypeAnte },
    { id: 3, label: lang.betTypeBuy }
  ];
  const comparing = Boolean(comparisonSlot && comparisonRows.length);
  const gameHeading = document.getElementById('game-daily-bet-game-heading');
  gameHeading.hidden = !comparing;
  const sourceGames = [
    { rows, slot: selectedSlot, group: 'primary' },
    ...(comparing ? [{ rows: comparisonRows, slot: comparisonSlot, group: 'secondary' }] : [])
  ];
  const detailRows = sourceGames.flatMap(game => game.rows.flatMap(row => betTypes.map(betType => {
    const prefix = `bet_${betType.id}`;
    const playerCount = Number(row[`${prefix}_player_count`] || 0);
    const spinCount = Number(row[`${prefix}_spin_count`] || 0);
    const betAmount = Number(row[`${prefix}_total_bet_amount`] || 0);
    const winAmount = Number(row[`${prefix}_total_win_amount`] || 0);
    const rtp = betAmount ? winAmount / betAmount * 100 : 0;
    const ggr = betAmount - winAmount;
    return {
      game_name: gameSeriesName(game.slot, game.rows), game_group: game.group,
      date: row.date, bet_type_label: betType.label, player_count: playerCount, spin_count: spinCount,
      bet_amount: betAmount, win_amount: winAmount, rtp, ggr
    };
  })));
  updateDetailSortHeaders('[data-game-detail-key]', gameDetailSort);
  gameDailyBetBody.innerHTML = sortDetailRows(detailRows, gameDetailSort).map(row => `<tr class="${comparing ? `game-comparison-${row.game_group}` : ''}">
    ${comparing ? `<td>${escapeHtml(row.game_name)}</td>` : ''}<td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.bet_type_label)}</td>
    <td>${formatCount(row.player_count)}</td><td>${formatCount(row.spin_count)}</td>
    <td>${formatCount(row.bet_amount)}</td><td>${formatCount(row.win_amount)}</td>
    <td>${row.rtp.toFixed(2)}%</td><td>${formatCount(row.ggr)}</td>
  </tr>`).join('');
}

function clearExpandedMonthlyCube() {
  document.querySelectorAll('.monthly-analysis-content .monthly-chart-panel.monthly-cube-expanded')
    .forEach(panel => panel.classList.remove('monthly-cube-expanded'));
}

document.querySelectorAll('.monthly-analysis-content .monthly-chart-panel').forEach(panel => {
  panel.addEventListener('click', () => {
    if (!['single', 'compare'].includes(monthlyModeSelect.value)) return;
    if (panel.dataset.cubeWidth === '2') {
      clearExpandedMonthlyCube();
      return;
    }
    document.querySelectorAll('.monthly-analysis-content .monthly-chart-panel').forEach(otherPanel => {
      const canExpand = otherPanel.dataset.cubeWidth !== '2';
      otherPanel.classList.toggle('monthly-cube-expanded', canExpand && otherPanel === panel);
    });
  });
});

document.addEventListener('click', event => {
  if (!event.target.closest('.monthly-analysis-content .monthly-chart-panel')) {
    clearExpandedMonthlyCube();
  }
});

function moveSelectByArrow(selectElement, direction, { skipEmpty = true } = {}) {
  const options = Array.from(selectElement.options).filter(option => !skipEmpty || option.value);
  if (!options.length) return null;
  const currentIndex = options.findIndex(option => option.value === selectElement.value);
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : options.length - 1)
    : Math.max(0, Math.min(options.length - 1, currentIndex + direction));
  if (currentIndex === nextIndex) return null;
  selectElement.value = options[nextIndex].value;
  selectElement.dispatchEvent(new Event('change', { bubbles: true }));
  return options[nextIndex];
}

function showNavigationToast(message) {
  window.clearTimeout(navigationToastTimer);
  navigationToast.textContent = message;
  navigationToast.classList.remove('visible');
  requestAnimationFrame(() => navigationToast.classList.add('visible'));
  navigationToastTimer = window.setTimeout(() => navigationToast.classList.remove('visible'), 1500);
}

document.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const target = event.target;
  if (target instanceof Element && target.closest('input, select, textarea, button, [contenteditable="true"]')) return;
  const direction = event.key === 'ArrowLeft' ? -1 : 1;
  const main = document.querySelector('main');
  let selectedOption = null;
  if (main.classList.contains('game-page')) {
    if (gameDateModeSelect.value === 'single-day') {
      (direction < 0 ? btnGamePreviousDay : btnGameNextDay).click();
      event.preventDefault();
      return;
    }
    selectedOption = moveSelectByArrow(gameSlotSelect, direction);
    if (selectedOption) showNavigationToast(translations[currentLang].keyboardGameSwitch.replace('{value}', selectedOption.textContent));
  } else if (main.classList.contains('player-page')) {
    selectedOption = moveSelectByArrow(playerSelect, direction);
    if (selectedOption) showNavigationToast(translations[currentLang].keyboardPlayerSwitch.replace('{value}', selectedOption.textContent));
  }
  if (selectedOption) event.preventDefault();
});

function renderGameSpinDistribution(rows, chartId = 'game-spin-distribution-chart', gameName = '') {
  const lang = translations[currentLang];
  const buckets = [
    ['dist_0_10', '[0,10)'], ['dist_10_20', '[10,20)'], ['dist_20_50', '[20,50)'],
    ['dist_50_100', '[50,100)'], ['dist_100_300', '[100,300)'], ['dist_300_500', '[300,500)'],
    ['dist_500_1000', '[500,1000)'], ['dist_1000_plus', '[1000,9999999)']
  ];
  const colors = ['#38bdf8', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899', '#f97316', '#eab308', '#10b981'];
  const dates = rows.map(row => row.date);
  const hasMedian = rows.some(row => row.median_player_spin_count != null);
  const singleMedian = hasMedian && rows.length === 1 ? Number(rows[0].median_player_spin_count) : null;
  const traces = buckets.map(([key, label], index) => ({
    x: dates,
    y: rows.map(row => Number(row[key] || 0) * 100),
    name: label,
    type: 'bar',
    marker: { color: colors[index] },
    hovertemplate: `${label}: %{y:.2f}%<extra></extra>`
  }));
  if (hasMedian) {
    traces.push({
      x: dates,
      y: rows.map(row => row.median_player_spin_count == null ? null : Number(row.median_player_spin_count)),
      name: lang.chartMedianPlayerSpins,
      type: 'scatter',
      mode: 'lines+markers',
      yaxis: 'y2',
      line: { color: '#0f172a', width: 3 },
      marker: { color: '#0f172a', size: 7 },
      connectgaps: false,
      hovertemplate: `${lang.chartMedianPlayerSpins}: %{y:,.1f}<extra></extra>`
    });
  }
  const chartTitle = gameName ? `${lang.chartGameSpinDistribution} · ${gameName}` : lang.chartGameSpinDistribution;
  Plotly.newPlot(chartId, traces, monthlyChartLayout(chartTitle, '%', {
    barmode: 'stack',
    barnorm: 'percent',
    margin: { l: 55, r: 65, t: 48, b: 105 },
    legend: {
      orientation: 'h',
      x: 0.5,
      xanchor: 'center',
      y: -0.28,
      yanchor: 'top',
      font: { color: '#475569' },
      bgcolor: 'rgba(255, 255, 255, 0.9)'
    },
    yaxis: { range: [0, 100], ticksuffix: '%', title: '%' },
    yaxis2: {
      visible: hasMedian,
      title: lang.chartMedianPlayerSpins,
      overlaying: 'y',
      side: 'right',
      rangemode: 'tozero',
      gridcolor: 'rgba(0,0,0,0)',
      tickfont: { color: '#0f172a' }
    },
    shapes: singleMedian == null ? [] : [{
      type: 'line', xref: 'paper', x0: 0, x1: 1,
      yref: 'y2', y0: singleMedian, y1: singleMedian,
      line: { color: '#0f172a', width: 3, dash: 'dash' }
    }]
  }), { responsive: true, displaylogo: false, displayModeBar: false });
}

function syncGameComparisonControls() {
  const selectedSlot = gameSlotSelect.value || 'ALL';
  const canCompare = selectedSlot !== 'ALL';
  gameCompareToggleControl.hidden = !canCompare;
  if (!canCompare) gameCompareCheckbox.checked = false;

  const previousComparison = gameCompareSlotSelect.value;
  const availableOptions = Array.from(gameSlotSelect.options).filter(option => option.value !== 'ALL' && option.value !== selectedSlot);
  gameCompareSlotSelect.innerHTML = '';
  availableOptions.forEach(source => {
    const option = document.createElement('option');
    option.value = source.value;
    option.dataset.gameName = source.dataset.gameName || '';
    option.textContent = source.textContent;
    gameCompareSlotSelect.appendChild(option);
  });
  if (availableOptions.some(option => option.value === previousComparison)) gameCompareSlotSelect.value = previousComparison;
  gameCompareCheckbox.disabled = availableOptions.length === 0;
  gameCompareSelectControl.hidden = !canCompare || !gameCompareCheckbox.checked || availableOptions.length === 0;
}

function gameSeriesName(slotId, rows) {
  const option = Array.from(gameSlotSelect.options).find(item => item.value === String(slotId));
  return formatGameNameOnly(slotId, option?.dataset.gameName || rows[0]?.game_name);
}

function renderGameComparisonCharts(primaryRows, comparisonRows, primaryHourly, comparisonHourly, primarySlot, comparisonSlot) {
  const lang = translations[currentLang];
  const singleDay = gameStartDate.value === gameEndDate.value;
  const common = { responsive: true, displaylogo: false, displayModeBar: false };
  const games = [
    { name: gameSeriesName(primarySlot, primaryRows), rows: primaryRows, hourly: primaryHourly, color: '#38bdf8' },
    { name: gameSeriesName(comparisonSlot, comparisonRows), rows: comparisonRows, hourly: comparisonHourly, color: '#f97316' }
  ];
  const lineTraces = (value, suffix = '') => games.map(game => ({
    x: game.rows.map(row => row.date), y: game.rows.map(value), name: `${game.name}${suffix}`,
    type: 'scatter', mode: 'lines+markers', line: { color: game.color, width: 3 }
  }));

  gameDauDnuPanel.hidden = singleDay;
  gameRtpPanel.hidden = singleDay;
  gameRetentionPanel.hidden = false;
  Plotly.newPlot('game-player-chart', lineTraces(row => Number(row.player_count || 0)), monthlyChartLayout(lang.chartGamePlayers, lang.axisPlayers), common);
  Plotly.newPlot('game-ggr-chart', games.map(game => ({
    x: singleDay ? [game.name] : game.rows.map(row => row.date),
    y: game.rows.map(row => Number(row.total_bet_amount || 0) - Number(row.total_win_amount || 0)),
    name: game.name, type: 'bar', marker: { color: game.color }
  })), monthlyChartLayout(singleDay ? lang.chartGameGgrByGame : lang.chartGameGgr, lang.axisGgr, { barmode: 'group' }), common);

  if (singleDay) {
    Plotly.newPlot('game-retention-chart', games.map(game => {
      const values = retentionBarItems(game.rows[0] || {});
      return { x: values.map(item => item.label), y: values.map(item => item.value), name: game.name, type: 'bar', marker: { color: game.color } };
    }), monthlyChartLayout(lang.chartGameRetention, lang.axisRetention, { barmode: 'group', yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
  } else {
    Plotly.newPlot('game-dau-dnu-chart', games.flatMap(game => [
      { x: game.rows.map(row => row.date), y: game.rows.map(row => Number(row.player_count || 0)), name: `${game.name} DAU`, type: 'scatter', mode: 'lines+markers', line: { color: game.color, width: 3 } },
      { x: game.rows.map(row => row.date), y: game.rows.map(row => Number(row.dnu || 0)), name: `${game.name} DNU`, type: 'scatter', mode: 'lines+markers', line: { color: game.color, width: 2, dash: 'dot' } }
    ]), monthlyChartLayout(lang.chartGameDauDnu, lang.axisPlayers), common);
    Plotly.newPlot('game-rtp-chart', lineTraces(row => Number(row.rtp || 0) * 100), monthlyChartLayout(lang.chartGameRtp, lang.axisRtp, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
    Plotly.newPlot('game-retention-chart', games.flatMap(game => [
      { x: game.rows.map(row => row.date), y: game.rows.map(row => matureRetentionPercent(row, 'retention_1', 1)), name: `${game.name} D1`, type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: game.color } },
      { x: game.rows.map(row => row.date), y: game.rows.map(row => matureRetentionPercent(row, 'retention_3', 3)), name: `${game.name} D3`, type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: game.color, dash: 'dash' } },
      { x: game.rows.map(row => row.date), y: game.rows.map(row => matureRetentionPercent(row, 'retention_7', 7)), name: `${game.name} D7`, type: 'scatter', mode: 'lines+markers', connectgaps: false, line: { color: game.color, dash: 'dot' } }
    ]), monthlyChartLayout(lang.chartGameRetention, lang.axisRetention, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
  }
  Plotly.newPlot('game-bet-type-chart', games.flatMap(game => [1, 2, 3].map((betType, index) => ({
    x: game.hourly.map(row => row.hour), y: game.hourly.map(row => Number(row[`bet_${betType}_player_count`] || 0)),
    name: `${game.name} ${[lang.betTypeNormal, lang.betTypeAnte, lang.betTypeBuy][index]}`,
    type: 'scatter', mode: 'lines+markers', line: { color: game.color, dash: ['solid', 'dash', 'dot'][index] }
  }))), monthlyChartLayout(singleDay ? lang.chartGameHourlyBetTypePlayers : lang.chartGameHourlyBetTypePlayersAverage, lang.axisPlayers, { xaxis: { dtick: 2 } }), common);
}

async function loadGameSpinMedians(startDate, endDate, slotId) {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    slot_id: slotId
  });
  const response = await fetch(`/api/game-spin-medians?${params}`);
  const rows = await response.json();
  if (!response.ok) throw new Error(translations[currentLang].apiRequestFailed);
  return rows;
}

async function loadGameDateDefaults() {
  try {
    const response = await fetch('/api/dates');
    const dates = await response.json();
    if (!Array.isArray(dates) || !dates.length) return;
    gameLatestAvailableDate = dates[0];
    gameSingleDate.max = gameLatestAvailableDate;
    gameStartDate.max = gameLatestAvailableDate;
    gameEndDate.max = gameLatestAvailableDate;
    setGameDateMode();
    loadGameData();
  } catch (error) {
    setLocalizedStatus(gameStatus, 'gameDateError');
  }
}

function shiftGameDate(dateValue, dayOffset) {
  const date = new Date(`${dateValue}T00:00:00`);
  date.setDate(date.getDate() + dayOffset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function setGameDateMode() {
  const mode = gameDateModeSelect.value;
  gameSingleDateControls.hidden = mode !== 'single-day';
  gameCustomDateControls.hidden = mode !== 'custom';
  if (!gameLatestAvailableDate) return;
  if (mode === 'today') {
    gameStartDate.value = gameLatestAvailableDate;
    gameEndDate.value = gameLatestAvailableDate;
  } else if (mode === 'yesterday') {
    gameStartDate.value = shiftGameDate(gameLatestAvailableDate, -1);
    gameEndDate.value = gameStartDate.value;
  } else if (mode === 'single-day') {
    if (!gameSingleDate.value) gameSingleDate.value = gameLatestAvailableDate;
    gameStartDate.value = gameSingleDate.value;
    gameEndDate.value = gameSingleDate.value;
  } else if (mode === 'seven-days') {
    gameStartDate.value = shiftGameDate(gameLatestAvailableDate, -6);
    gameEndDate.value = gameLatestAvailableDate;
  } else {
    if (!gameStartDate.value) gameStartDate.value = gameLatestAvailableDate;
    if (!gameEndDate.value) gameEndDate.value = gameLatestAvailableDate;
  }
}

async function loadGameData() {
  const startDate = gameStartDate.value;
  const endDate = gameEndDate.value;
  const selectedSlot = gameSlotSelect.value || 'ALL';
  syncGameComparisonControls();
  const comparisonSlot = selectedSlot !== 'ALL' && gameCompareCheckbox.checked ? gameCompareSlotSelect.value : '';
  const rankingRequestId = ++gameRankingRequestId;
  const singleDay = startDate && startDate === endDate;
  const requestedSingleDate = gameDateModeSelect.value === 'single-day' ? gameSingleDate.value : '';
  const previousPanelState = requestedSingleDate ? {
    spinDistribution: gameSpinDistributionPanel.hidden,
    dailyBet: gameDailyBetPanel.hidden,
    ranking: gameRankingPanel.hidden,
    dauDnu: gameDauDnuPanel.hidden,
    rtp: gameRtpPanel.hidden,
    retention: gameRetentionPanel.hidden
  } : null;
  gameSpinDistributionPanel.hidden = true;
  gameCompareSpinDistributionPanel.hidden = true;
  gameDailyBetPanel.hidden = true;
  gameRankingPanel.hidden = true;
  gameDauDnuPanel.hidden = singleDay;
  gameRtpPanel.hidden = singleDay;
  gameRetentionPanel.hidden = false;
  if (!startDate || !endDate) return;
  setLocalizedStatus(gameStatus, 'gameLoading');
  try {
    const response = await fetch(`/api/game?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&slot_id=${encodeURIComponent(selectedSlot)}`);
    const rows = await response.json();
    if (!response.ok) throw new Error(translations[currentLang].apiRequestFailed);
    if (!rows.length) {
      if (requestedSingleDate) {
        if (lastLoadedGameSingleDate && lastLoadedGameSingleDate !== requestedSingleDate) {
          gameSingleDate.value = lastLoadedGameSingleDate;
          gameStartDate.value = lastLoadedGameSingleDate;
          gameEndDate.value = lastLoadedGameSingleDate;
          saveUiState();
        }
        gameSpinDistributionPanel.hidden = previousPanelState.spinDistribution;
        gameDailyBetPanel.hidden = previousPanelState.dailyBet;
        gameRankingPanel.hidden = previousPanelState.ranking;
        gameDauDnuPanel.hidden = previousPanelState.dauDnu;
        gameRtpPanel.hidden = previousPanelState.rtp;
        gameRetentionPanel.hidden = previousPanelState.retention;
        setLocalizedStatus(gameStatus, 'gameNoData');
        window.alert(translations[currentLang].gameDayNoData.replace('{date}', requestedSingleDate));
        return;
      }
      gameSpinDistributionCache = [];
      gameComparisonDataCache = [];
      gameComparisonSlotCache = '';
      gameRankingCache = [];
      gameDataCache = [];
      gameDailyBetBody.innerHTML = '';
      setLocalizedStatus(gameStatus, 'gameNoData');
      return;
    }
    if (requestedSingleDate) lastLoadedGameSingleDate = requestedSingleDate;
    const hourlyParams = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      slot_id: selectedSlot
    });
    const hourlyResponse = await fetch(`/api/game-hourly-players?${hourlyParams}`);
    const hourlyRows = await hourlyResponse.json();
    if (!hourlyResponse.ok) throw new Error(translations[currentLang].apiRequestFailed);
    gameHourlyPlayersCache = hourlyRows;
    gameDataCache = rows;
    if (selectedSlot === 'ALL') {
      const games = new Map();
      rows.forEach(row => games.set(String(row.slot_id), formatGameNameOnly(row.slot_id, row.game_name)));
      const slots = [...games.keys()].sort((a, b) => Number(a) - Number(b));
      const current = gameSlotSelect.value;
      const lang = translations[currentLang];
      gameSlotSelect.innerHTML = '';
      const allOption = document.createElement('option');
      allOption.value = 'ALL';
      allOption.textContent = lang.allGames;
      gameSlotSelect.appendChild(allOption);
      slots.forEach(slot => {
        const option = document.createElement('option');
        option.value = slot;
        option.dataset.gameName = games.get(slot);
        option.textContent = lang.gameOption.replace('{name}', games.get(slot));
        gameSlotSelect.appendChild(option);
      });
      gameSlotSelect.value = slots.includes(current) ? current : 'ALL';
      syncGameComparisonControls();
      if (pendingGameSlot && slots.includes(pendingGameSlot)) {
        gameSlotSelect.value = pendingGameSlot;
        pendingGameSlot = '';
        saveUiState();
        loadGameData();
        return;
      }
    }
    let comparisonRows = [];
    let comparisonHourlyRows = [];
    if (comparisonSlot) {
      const comparisonParams = new URLSearchParams({ start_date: startDate, end_date: endDate, slot_id: comparisonSlot });
      const [comparisonResponse, comparisonHourlyResponse] = await Promise.all([
        fetch(`/api/game?${comparisonParams}`),
        fetch(`/api/game-hourly-players?${comparisonParams}`)
      ]);
      comparisonRows = await comparisonResponse.json();
      comparisonHourlyRows = await comparisonHourlyResponse.json();
      if (!comparisonResponse.ok || !comparisonHourlyResponse.ok) throw new Error(translations[currentLang].apiRequestFailed);
    }
    gameComparisonDataCache = comparisonRows;
    gameComparisonSlotCache = comparisonRows.length ? comparisonSlot : '';
    updateGameMetrics(rows, selectedSlot);
    if (comparisonSlot && comparisonRows.length) {
      renderGameComparisonCharts(rows, comparisonRows, gameHourlyPlayersCache, comparisonHourlyRows, selectedSlot, comparisonSlot);
    } else {
      renderGameCharts(rows, selectedSlot, gameHourlyPlayersCache);
    }
    renderGameDailyBetStats(rows, selectedSlot, comparisonRows, comparisonSlot);
    if (selectedSlot === 'ALL') {
      gameSpinDistributionCache = [];
      gameComparisonDataCache = [];
      gameComparisonSlotCache = '';
      gameSpinDistributionPanel.hidden = true;
      gameCompareSpinDistributionPanel.hidden = true;
      loadGameRanking(startDate, endDate, rankingRequestId).catch(error => {
        if (rankingRequestId !== gameRankingRequestId) return;
        console.error('Failed to load game ranking:', error);
        gameRankingCache = [];
        gameRankingPanel.hidden = false;
        renderGameRanking();
      });
    } else {
      gameRankingCache = [];
      gameRankingPanel.hidden = true;
      gameSpinDistributionCache = rows;
      gameSpinDistributionPanel.hidden = false;
      gameCompareSpinDistributionPanel.hidden = !comparisonSlot || !comparisonRows.length;
      const primaryName = gameSeriesName(selectedSlot, rows);
      const comparisonName = comparisonRows.length ? gameSeriesName(comparisonSlot, comparisonRows) : '';
      renderGameSpinDistribution(rows, 'game-spin-distribution-chart', primaryName);
      if (comparisonRows.length) renderGameSpinDistribution(comparisonRows, 'game-compare-spin-distribution-chart', comparisonName);
      const medianRequests = [loadGameSpinMedians(startDate, endDate, selectedSlot)];
      if (comparisonRows.length) medianRequests.push(loadGameSpinMedians(startDate, endDate, comparisonSlot));
      Promise.all(medianRequests).then(([medianRows, comparisonMedianRows = []]) => {
        if (rankingRequestId !== gameRankingRequestId || gameSlotSelect.value !== selectedSlot) return;
        const medianByDate = new Map(medianRows.map(row => [row.date, row.median_player_spin_count]));
        gameSpinDistributionCache = rows.map(row => ({
          ...row,
          median_player_spin_count: medianByDate.has(row.date) ? medianByDate.get(row.date) : null
        }));
        renderGameSpinDistribution(gameSpinDistributionCache, 'game-spin-distribution-chart', primaryName);
        if (comparisonRows.length) {
          const comparisonMedianByDate = new Map(comparisonMedianRows.map(row => [row.date, row.median_player_spin_count]));
          gameComparisonDataCache = comparisonRows.map(row => ({
            ...row,
            median_player_spin_count: comparisonMedianByDate.has(row.date) ? comparisonMedianByDate.get(row.date) : null
          }));
          renderGameSpinDistribution(gameComparisonDataCache, 'game-compare-spin-distribution-chart', comparisonName);
        }
      }).catch(error => {
        if (rankingRequestId !== gameRankingRequestId) return;
        console.error('Failed to load game spin medians:', error);
        setLocalizedStatus(gameStatus, 'gameMedianLoadError', { message: error.message });
      });
    }
    setLocalizedStatus(gameStatus, 'gameLoaded', { start: startDate, end: endDate });
  } catch (error) {
    setLocalizedStatus(gameStatus, 'gameLoadError', { message: error.message });
  }
}

btnLoadMonthly.addEventListener('click', loadMonthlyData);
monthlyMonthSelect.addEventListener('change', loadMonthlyData);
[btnMonthlyPrevious, btnMonthlyNext].forEach((button, index) => {
  button.addEventListener('click', () => {
    const selectedMonth = monthlyMonthSelect.value || latestAvailableMonth;
    const targetMonth = shiftMonth(selectedMonth, index === 0 ? -1 : 1);
    if (!targetMonth) return;
    monthlyMonthSelect.value = targetMonth;
    monthlyMonthSelect.dispatchEvent(new Event('change', { bubbles: true }));
  });
});
monthlyModeSelect.addEventListener('change', () => {
  setMonthlyMode();
  loadMonthlyData();
});
monthlyStartMonth.addEventListener('change', loadMonthlyData);
monthlyEndMonth.addEventListener('change', loadMonthlyData);
btnLoadGame.addEventListener('click', loadGameData);
btnLoadAgent.addEventListener('click', loadAgentAnalysis);
agentParentSelect.addEventListener('change', () => {
  populateAgentSelect();
  saveUiState();
  if (agentStartDate.value && agentEndDate.value) loadAgentAnalysis();
});
agentSelect.addEventListener('change', () => {
  agentGameSelect.value = 'ALL';
  updateAgentFilterVisibility();
  saveUiState();
  if (agentStartDate.value && agentEndDate.value) loadAgentAnalysis();
});
agentGameSelect.addEventListener('change', () => {
  saveUiState();
  if (agentAnalysisCache) renderAgentAnalysis(agentAnalysisCache);
});
gameSlotSelect.addEventListener('change', () => {
  syncGameComparisonControls();
  loadGameData();
});
gameCompareCheckbox.addEventListener('change', () => {
  syncGameComparisonControls();
  loadGameData();
});
gameCompareSlotSelect.addEventListener('change', loadGameData);
gameDateModeSelect.addEventListener('change', () => {
  setGameDateMode();
  saveUiState();
  if (gameLatestAvailableDate) loadGameData();
  else loadGameDateDefaults();
});
gameSingleDate.addEventListener('change', () => {
  if (gameDateModeSelect.value !== 'single-day') return;
  setGameDateMode();
  saveUiState();
  loadGameData();
});
[btnGamePreviousDay, btnGameNextDay].forEach((button, index) => {
  button.addEventListener('click', () => {
    const selectedDate = gameSingleDate.value || gameLatestAvailableDate;
    if (!selectedDate) return;
    gameSingleDate.value = shiftGameDate(selectedDate, index === 0 ? -1 : 1);
    gameSingleDate.dispatchEvent(new Event('change', { bubbles: true }));
  });
});
document.querySelectorAll('[data-ranking-key]').forEach(button => {
  button.addEventListener('click', () => {
    const key = button.dataset.rankingKey;
    monthlyRankingSort = monthlyRankingSort.key === key
      ? { key, direction: monthlyRankingSort.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'game_name' ? 'asc' : 'desc' };
    renderMonthlyGameRanking();
  });
});
document.querySelectorAll('[data-game-ranking-key]').forEach(button => {
  button.addEventListener('click', () => {
    const key = button.dataset.gameRankingKey;
    gameRankingSort = gameRankingSort.key === key
      ? { key, direction: gameRankingSort.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'game_name' ? 'asc' : 'desc' };
    renderGameRanking();
  });
});

[monthlyModeSelect, monthlyMonthSelect, monthlyStartMonth, monthlyEndMonth, gameSingleDate, gameStartDate, gameEndDate, gameSlotSelect,
  agentParentSelect, agentSelect, agentGameSelect, agentStartDate, agentEndDate,
  dateModeSelect, dateSelect, dateStartSelect, dateEndSelect, minSpinsInput, maxSpinsInput,
  playerGameSelect, playerSelect, checkboxNewPlayer, checkboxOldPlayer, checkboxWinPlayer, checkboxLosePlayer,
  btnLangToggle].forEach(element => element.addEventListener('change', saveUiState));

function restoreUiState() {
  restoredUiState = readUiState();
  if (!restoredUiState) return 'home';
  restoredUiState.activePage = 'home';

  if (restoredUiState.lang === 'en' || restoredUiState.lang === 'zh') currentLang = restoredUiState.lang;
  const monthly = restoredUiState.monthly || {};
  if (['single', 'compare', 'quarter', 'half-year', 'year'].includes(monthly.mode)) monthlyModeSelect.value = monthly.mode;
  if (monthly.month) monthlyMonthSelect.value = monthly.month;
  lastLoadedMonthlyMonth = monthlyMonthSelect.value;
  if (monthly.startMonth) monthlyStartMonth.value = monthly.startMonth;
  if (monthly.endMonth) monthlyEndMonth.value = monthly.endMonth;
  setMonthlyMode();

  const game = restoredUiState.game || {};
  if (['today', 'yesterday', 'single-day', 'seven-days', 'custom'].includes(game.dateMode)) gameDateModeSelect.value = game.dateMode;
  if (game.singleDate) gameSingleDate.value = game.singleDate;
  lastLoadedGameSingleDate = gameSingleDate.value;
  if (game.startDate) gameStartDate.value = game.startDate;
  if (game.endDate) gameEndDate.value = game.endDate;
  gameSingleDateControls.hidden = gameDateModeSelect.value !== 'single-day';
  gameCustomDateControls.hidden = gameDateModeSelect.value !== 'custom';
  pendingGameSlot = game.slot && game.slot !== 'ALL' ? String(game.slot) : '';

  const agent = restoredUiState.agent || {};
  if (agent.startDate) agentStartDate.value = agent.startDate;
  if (agent.endDate) agentEndDate.value = agent.endDate;

  const player = restoredUiState.player || {};
  if (player.dateMode === 'single' || player.dateMode === 'range') dateModeSelect.value = player.dateMode;
  containerSingleDate.style.display = dateModeSelect.value === 'single' ? 'block' : 'none';
  containerRangeDate.style.display = dateModeSelect.value === 'range' ? 'block' : 'none';
  if (player.minSpins !== undefined) minSpinsInput.value = player.minSpins;
  if (player.maxSpins !== undefined) maxSpinsInput.value = player.maxSpins;
  pendingPlayerGame = player.game ? String(player.game) : 'ALL';
  pendingPlayerId = player.playerId ? String(player.playerId) : '';
  ['newPlayer', 'oldPlayer', 'winPlayer', 'losePlayer'].forEach(key => {
    const element = { newPlayer: checkboxNewPlayer, oldPlayer: checkboxOldPlayer, winPlayer: checkboxWinPlayer, losePlayer: checkboxLosePlayer }[key];
    if (typeof player[key] === 'boolean') element.checked = player[key];
  });

  return 'home';
}

function renderMonthlyGameRanking() {
  const body = document.getElementById('monthly-game-ranking-body');
  const { key, direction } = monthlyRankingSort;
  const rows = [...monthlyGameRankingCache].sort((a, b) => {
    const result = key === 'game_name'
      ? String(a[key] || '').localeCompare(String(b[key] || ''), activeLocale())
      : Number(a[key] || 0) - Number(b[key] || 0);
    return direction === 'asc' ? result : -result;
  });
  const totalKeys = new Set(['total_spin_count', 'total_bet_amount', 'total_win_amount', 'ggr']);
  const columnTotals = Object.fromEntries(Array.from(totalKeys, totalKey => [
    totalKey,
    monthlyGameRankingCache.reduce((sum, row) => sum + Number(row[totalKey] || 0), 0)
  ]));
  document.querySelectorAll('[data-ranking-key]').forEach(button => {
    const active = button.dataset.rankingKey === key;
    button.classList.toggle('active', active);
    const columnKey = button.dataset.rankingKey;
    const label = button.dataset.label || button.textContent;
    const arrow = active ? ` ${direction === 'asc' ? '↑' : '↓'}` : '';
    button.innerHTML = totalKeys.has(columnKey)
      ? `${label}${arrow}<span class="ranking-header-total">${formatCount(columnTotals[columnKey])}</span>`
      : `${label}${arrow}`;
  });
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9">${translations[currentLang].rankingEmpty}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(row => `<tr>
    <td><a href="#game-analysis" class="monthly-ranking-game-link">${escapeHtml(formatGameNameOnly(row.slot_id, row.game_name))}</a></td>
    <td>${formatCount(row.days)}</td>
    <td>${formatCount(row.player_count)}</td>
    <td>${Number(row.avg_spin_count || 0).toLocaleString(activeLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    <td>${Number(row.avg_bet_amount || 0).toLocaleString(activeLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    <td>${formatCount(row.total_spin_count)}</td>
    <td>${formatCount(row.total_bet_amount)}</td>
    <td>${formatCount(row.total_win_amount)}</td>
    <td>${formatCount(row.ggr)}</td>
  </tr>`).join('');
  body.querySelectorAll('.monthly-ranking-game-link').forEach((link, index) => {
    const game = rows[index];
    const gameName = formatGameNameOnly(game.slot_id, game.game_name);
    link.title = translations[currentLang].openGameAnalysis.replace('{game}', gameName);
    link.addEventListener('click', event => {
      event.preventDefault();
      gameDateModeSelect.value = 'custom';
      setGameDateMode();
      gameStartDate.value = monthlyGameRankingRange.startDate;
      gameEndDate.value = monthlyGameRankingRange.endDate;
      const slotId = String(game.slot_id);
      const slotIsLoaded = Array.from(gameSlotSelect.options).some(option => option.value === slotId);
      pendingGameSlot = slotIsLoaded ? '' : slotId;
      gameSlotSelect.value = slotIsLoaded ? slotId : 'ALL';
      setActivePage('game');
      if (gameLatestAvailableDate) loadGameData();
    });
  });
}

async function loadMonthlyGameRanking(startDate, endDate) {
  const response = await fetch(`/api/game-ranking?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`);
  const rows = await response.json();
  if (!response.ok) throw new Error(translations[currentLang].apiRequestFailed);
  monthlyGameRankingRange = { startDate, endDate };
  monthlyGameRankingCache = Array.isArray(rows) ? rows : [];
  renderMonthlyGameRanking();
}

function renderGameRanking() {
  const body = document.getElementById('game-ranking-body');
  const { key, direction } = gameRankingSort;
  const rows = [...gameRankingCache].sort((a, b) => {
    const result = key === 'game_name'
      ? String(a[key] || '').localeCompare(String(b[key] || ''), activeLocale())
      : Number(a[key] || 0) - Number(b[key] || 0);
    return direction === 'asc' ? result : -result;
  });
  const totalKeys = new Set(['total_spin_count', 'total_bet_amount', 'total_win_amount', 'ggr']);
  const columnTotals = Object.fromEntries(Array.from(totalKeys, totalKey => [
    totalKey, gameRankingCache.reduce((sum, row) => sum + Number(row[totalKey] || 0), 0)
  ]));
  document.querySelectorAll('[data-game-ranking-key]').forEach(button => {
    const columnKey = button.dataset.gameRankingKey;
    const active = columnKey === key;
    button.classList.toggle('active', active);
    const label = button.dataset.label || button.textContent;
    const arrow = active ? ` ${direction === 'asc' ? '↑' : '↓'}` : '';
    button.innerHTML = totalKeys.has(columnKey)
      ? `${label}${arrow}<span class="ranking-header-total">${formatCount(columnTotals[columnKey])}</span>`
      : `${label}${arrow}`;
  });
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9">${translations[currentLang].rankingEmpty}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(row => `<tr>
    <td>${escapeHtml(formatGameNameOnly(row.slot_id, row.game_name))}</td>
    <td>${formatCount(row.days)}</td>
    <td>${formatCount(row.player_count)}</td>
    <td>${Number(row.avg_spin_count || 0).toLocaleString(activeLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    <td>${Number(row.avg_bet_amount || 0).toLocaleString(activeLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    <td>${formatCount(row.total_spin_count)}</td>
    <td>${formatCount(row.total_bet_amount)}</td>
    <td>${formatCount(row.total_win_amount)}</td>
    <td>${formatCount(row.ggr)}</td>
  </tr>`).join('');
}

async function loadGameRanking(startDate, endDate, requestId) {
  const response = await fetch(`/api/game-ranking?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`);
  const rows = await response.json();
  if (!response.ok) throw new Error(translations[currentLang].apiRequestFailed);
  if (requestId !== gameRankingRequestId) return;
  gameRankingCache = Array.isArray(rows) ? rows : [];
  gameRankingPanel.hidden = false;
  renderGameRanking();
}

function showLoginScreen(message = '') {
  document.body.classList.add('auth-locked');
  loginError.textContent = message;
  loginPassword.value = '';
  window.setTimeout(() => loginPassword.focus(), 0);
}

function initializeDashboard() {
  document.body.classList.remove('auth-locked');
  if (dashboardInitialized) return;
  dashboardInitialized = true;
  const activePage = restoreUiState();
  updateLanguageUI();
  loadAvailableDates();
  loadPlayerGames();
  setActivePage(activePage);
  startHomeAutoRefresh();
  if (activePage === 'monthly' && monthlyMonthSelect.value) loadMonthlyData();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || document.body.classList.contains('auth-locked') || homeContent.hidden) return;
  if (Date.now() - homeDashboardLoadedAt >= HOME_REFRESH_INTERVAL_MS) {
    loadHomeDashboard({ silent: true });
  }
});

btnOpenSinglePlayer.addEventListener('click', () => {
  const playerId = playerSelect.value;
  if (!playerId) return;
  const startDate = dateModeSelect.value === 'single' ? dateSelect.value : dateStartSelect.value;
  const endDate = dateModeSelect.value === 'single' ? dateSelect.value : dateEndSelect.value;
  if (!startDate || !endDate) return;
  singlePlayerName.value = playerId;
  singlePlayerStartDate.value = startDate;
  singlePlayerEndDate.value = endDate;
  setLocalizedStatus(singlePlayerStatus, '');
  setActivePage('single-player');
  loadSinglePlayerData(playerId);
});
document.querySelectorAll('[data-game-detail-key]').forEach(button => {
  button.addEventListener('click', () => {
    gameDetailSort = toggleDetailSort(gameDetailSort, button.dataset.gameDetailKey);
    renderGameDailyBetStats(gameDataCache, gameSlotSelect.value || 'ALL', gameComparisonDataCache, gameComparisonSlotCache);
  });
});
document.querySelectorAll('[data-agent-game-detail-key]').forEach(button => {
  button.addEventListener('click', () => {
    agentGameDetailSort = toggleDetailSort(agentGameDetailSort, button.dataset.agentGameDetailKey);
    if (agentGamePerformanceCache) renderAgentGamePerformance(agentGamePerformanceCache);
  });
});
document.getElementById('agent-details-head').addEventListener('click', event => {
  const button = event.target.closest('[data-agent-detail-key]');
  if (!button) return;
  agentDetailSort = toggleDetailSort(agentDetailSort, button.dataset.agentDetailKey);
  if (agentAnalysisCache) renderAgentAnalysis(agentAnalysisCache);
});

window.fetch = async (...args) => {
  activeDataRequestCount += 1;
  globalDataLoading.hidden = false;
  try {
    const response = await originalFetch(...args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (response.status === 401 && !url.includes('/api/auth/')) showLoginScreen();
    return response;
  } finally {
    activeDataRequestCount = Math.max(0, activeDataRequestCount - 1);
    globalDataLoading.hidden = activeDataRequestCount === 0;
  }
};

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  loginError.textContent = '';
  loginSubmit.disabled = true;
  loginSubmit.textContent = translations[currentLang].loginSubmitting;
  try {
    const response = await originalFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: loginPassword.value })
    });
    if (!response.ok) {
      showLoginScreen(translations[currentLang].loginInvalid);
      return;
    }
    initializeDashboard();
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = translations[currentLang].loginSubmit;
  }
});

btnLogout.addEventListener('click', async () => {
  try {
    await originalFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    showLoginScreen();
  }
});

// 網頁加載完成後先確認登入狀態，再初始化儀表板
window.addEventListener('DOMContentLoaded', async () => {
  updateLanguageUI();
  try {
    const response = await originalFetch('/api/auth/status');
    const status = response.ok ? await response.json() : { authenticated: false };
    if (status.authenticated) initializeDashboard();
    else showLoginScreen();
  } catch (error) {
    showLoginScreen(error.message);
  }
});
