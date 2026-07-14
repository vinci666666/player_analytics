import {
  escapeHtml,
  formatCount,
  formatCurrency,
  formatDateTimeForTooltip,
  formatDateTimeText,
  formatNullableCurrency,
  parseNullableNumber
} from './js/formatters.js';
import {
  addOneCalendarMonth,
  getCalendarMonthRange,
  getDefaultRangeStartDate,
  getPreviousCalendarMonthRange,
  isDateRangeOverOneMonth,
  monthIndex,
  shiftMonth
} from './js/date-utils.js';
import { installAutoFitText } from './js/text-fit.js';

// iGaming 玩家投注行為分析儀表板前端邏輯 - 連接本地 PostgreSQL 後端

// 全域狀態變數
let analyzedData = [];      // 用於快取目前所選玩家在指定日期的所有旋轉紀錄
let currentLang = 'zh';     // 語系設定：預設為繁體中文 ('zh')，支援切換為英文 ('en')
let currentPlayersRequestController = null;
let currentDataRequestController = null;
let monthlyDataCache = [];
let latestAvailableMonth = '';
let gameDataCache = [];
let monthlyGameRankingCache = [];
let monthlyRankingSort = { key: 'total_spin_count', direction: 'desc' };
let gameSpinDistributionCache = [];
let gameRankingCache = [];
let gameRankingSort = { key: 'total_spin_count', direction: 'desc' };
let gameRankingRequestId = 0;
let homeDashboardCache = null;
const UI_STATE_KEY = 'playerAnalytics.uiState.v1';
let restoredUiState = null;
let pendingGameSlot = '';
let pendingPlayerId = '';
let navigationToastTimer = null;

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
        startDate: gameStartDate.value,
        endDate: gameEndDate.value,
        slot: gameSlotSelect.value || pendingGameSlot || 'ALL'
      },
      player: {
        dateMode: dateModeSelect.value,
        date: dateSelect.value,
        startDate: dateStartSelect.value,
        endDate: dateEndSelect.value,
        minSpins: minSpinsInput.value,
        maxSpins: maxSpinsInput.value,
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
const playerSelect = document.getElementById('player-select');
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
const monthlyCompareControls = document.getElementById('monthly-compare-controls');
const monthlyStartMonth = document.getElementById('monthly-start-month');
const monthlyEndMonth = document.getElementById('monthly-end-month');
const monthlyBetTypePanel = document.getElementById('monthly-bet-type-panel');
const monthlyRetention3Panel = document.getElementById('monthly-retention-3-panel');
const monthlyRetention7Panel = document.getElementById('monthly-retention-7-panel');
const btnLoadMonthly = document.getElementById('btn-load-monthly');
const monthlyStatus = document.getElementById('monthly-status');
const gameContent = document.getElementById('game-analysis-content');
const gameSlotSelect = document.getElementById('game-slot-select');
const gameStartDate = document.getElementById('game-start-date');
const gameEndDate = document.getElementById('game-end-date');
const btnLoadGame = document.getElementById('btn-load-game');
const gameStatus = document.getElementById('game-status');
const gameSpinDistributionPanel = document.getElementById('game-spin-distribution-panel');
const gameRankingPanel = document.getElementById('game-ranking-panel');
const navigationToast = document.getElementById('navigation-toast');
const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginSubmit = document.getElementById('login-submit');
const loginError = document.getElementById('login-error');
const btnLogout = document.getElementById('btn-logout');
const originalFetch = window.fetch.bind(window);
let dashboardInitialized = false;

pageNavItems.forEach((item) => {
  item.addEventListener('click', (event) => {
    const page = item.dataset.page;
    if (page === 'home' || page === 'monthly' || page === 'game') {
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
    thSeq: "Sequence",
    thPlayer: "Player ID",
    thTime: "Timestamp (bet_at)",
    thSlot: "Game Name",
    thBetType: "Wager Type",
    betTypeNormal: "Standard Wager",
    betTypeAnte: "Ante Wager",
    betTypeBuy: "Feature Buy",
    betTypeUnknown: "unknown ({type})",
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
    tooltipNewGame: "New Game ID",
    tooltipCumShort: "Cum. Profit",
    navTitle: "Operations Analytics",
    navEyebrow: "ANALYTICS",
    monthlyEyebrow: "MONTHLY OPERATIONS",
    gameEyebrow: "GAME PERFORMANCE",
    navHome: "Operations Overview",
    navMonthly: "Monthly Operations",
    navGame: "Game Performance",
    navPlayer: "Player Behavior",
    homeEyebrow: "OPERATIONS OVERVIEW",
    homeTitle: "Operations Overview",
    homeDescription: "Monitor operating performance, game rankings, and high-profit player alerts",
    homeDataDate: "Data as of: {date}",
    homeMonthTitle: "Month-to-Date Performance",
    homeMonthRangeComparison: "{currentStart}–{currentEnd} vs. {previousStart}–{previousEnd}",
    homeDayTitle: "Current-Day Performance",
    homeGameRankingTitle: "Game Performance Rankings",
    homePlayerAlertTitle: "High-Profit Player Alerts",
    homeSevenDayTop10: "Last 7 Days · Top 10",
    homeCurrentDayTop5: "Current Day · Top 5",
    homeComparedPrevious: "vs. previous month {value}%",
    homeGgr30d: "30-Day GGR Trend",
    homeProfit: "Player Profit",
    homeLoading: "Loading operations overview…",
    homeLoadError: "Failed to load operations overview: {message}",
    monthlyTitle: "Monthly Operations Analysis",
    monthlyDescription: "Operating KPIs, retention, and game performance trends",
    gameTitle: "Game Performance Analysis",
    gameDescription: "Daily engagement, monetization, and retention by game",
    labelAnalysisMonth: "Analysis Month",
    labelPeriodEndMonth: "End Month",
    labelMonthlyMode: "Analysis Mode",
    monthlyModeSingle: "Single Month",
    monthlyModeCompare: "Compare Months",
    monthlyModeQuarter: "Quarter Analysis",
    monthlyModeHalfYear: "Half-Year Analysis",
    monthlyModeYear: "Year Analysis",
    labelStartMonth: "Start Month",
    labelEndMonth: "End Month",
    monthlyRangeOrderError: "Start month must be before or equal to end month.",
    monthlyRangeLimitError: "Month comparison is limited to 6 months.",
    labelGame: "Game",
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
    monthlyLoaded: "Loaded {days} days from {start} to {end}.",
    monthlyDateError: "Unable to load available dates. Please select dates manually.",
    monthlyLoadError: "Failed to load monthly analysis: {message}",
    gameLoading: "Loading game analysis…",
    gameNoData: "No game analysis data for the selected dates.",
    gameLoaded: "Loaded game data from {start} to {end}.",
    gameDateError: "Unable to load available dates. Please select dates manually.",
    gameLoadError: "Failed to load game analysis: {message}",
    gameOption: "{name} (ID {slot})",
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
    chartGameGgr: "Daily Game GGR",
    chartGameRtp: "Game RTP Trend",
    chartGameRetention: "Game Retention Trend",
    chartGameBetTypePlayers: "Game Bet Type Player Count",
    axisPlayers: "Players",
    axisRtp: "RTP (%)",
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
    rangeLimitError: "Time interval must be within one month",
    loading: "Loading...",
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
    logout: "Sign Out"
  },
  zh: {
    title: "iGaming 營運分析平台",
    subtitle: "// 玩家與遊戲績效分析",
    legendCurve: "累計利潤曲線",
    legendFg: "免費遊戲標記",
    legendGs: "切換遊戲標記",
    filterTitle: "玩家分析篩選條件",
    labelActivePlayer: "玩家 ID",
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
    thSeq: "投注序號",
    thPlayer: "玩家 ID",
    thTime: "時間戳記 (bet_at)",
    thSlot: "遊戲名稱",
    thBetType: "投注方式",
    betTypeNormal: "標準投注",
    betTypeAnte: "Ante 投注",
    betTypeBuy: "購買特色遊戲",
    betTypeUnknown: "未知 ({type})",
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
    tooltipNewGame: "新遊戲 ID",
    tooltipCumShort: "累計利潤",
    navTitle: "營運分析中心",
    navEyebrow: "數據分析",
    monthlyEyebrow: "月度營運",
    gameEyebrow: "遊戲績效",
    navHome: "營運總覽",
    navMonthly: "月度營運分析",
    navGame: "遊戲績效分析",
    navPlayer: "玩家行為分析",
    homeEyebrow: "營運總覽",
    homeTitle: "營運總覽",
    homeDescription: "即時掌握營運績效、遊戲排行與高獲利玩家警示",
    homeDataDate: "資料基準日：{date}",
    homeMonthTitle: "本月累積績效",
    homeMonthRangeComparison: "{currentStart}–{currentEnd} 對比 {previousStart}–{previousEnd}",
    homeDayTitle: "當日累積績效",
    homeGameRankingTitle: "遊戲績效排名",
    homePlayerAlertTitle: "高獲利玩家警示",
    homeSevenDayTop10: "近 7 日 · Top 10",
    homeCurrentDayTop5: "當日 · Top 5",
    homeComparedPrevious: "較上月 {value}%",
    homeGgr30d: "近 30 日 GGR 趨勢",
    homeProfit: "玩家獲利",
    homeLoading: "正在載入營運總覽…",
    homeLoadError: "營運總覽載入失敗：{message}",
    monthlyTitle: "月度營運分析",
    monthlyDescription: "營運指標、玩家留存與遊戲績效趨勢",
    gameTitle: "遊戲績效分析",
    gameDescription: "依遊戲檢視每日參與度、營收與留存表現",
    labelAnalysisMonth: "分析月份",
    labelPeriodEndMonth: "結束月份",
    labelMonthlyMode: "分析模式",
    monthlyModeSingle: "單月資料",
    monthlyModeCompare: "月比較",
    monthlyModeQuarter: "季分析",
    monthlyModeHalfYear: "半年分析",
    monthlyModeYear: "年分析",
    labelStartMonth: "開始月份",
    labelEndMonth: "結束月份",
    monthlyRangeOrderError: "開始月份必須早於或等於結束月份。",
    monthlyRangeLimitError: "月比較區間最多為 6 個月。",
    labelGame: "遊戲",
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
    monthlyLoaded: "已載入 {start} 至 {end} 的 {days} 天資料。",
    monthlyDateError: "無法取得可用日期，請手動選擇日期。",
    monthlyLoadError: "月度營運分析載入失敗：{message}",
    gameLoading: "正在載入遊戲績效資料…",
    gameNoData: "所選期間沒有遊戲績效資料。",
    gameLoaded: "已載入 {start} 至 {end} 的遊戲資料。",
    gameDateError: "無法取得可用日期，請手動選擇日期。",
    gameLoadError: "遊戲績效分析載入失敗：{message}",
    gameOption: "{name}（ID {slot}）",
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
    chartGameGgr: "遊戲每日 GGR",
    chartGameRtp: "遊戲 RTP 趨勢",
    chartGameRetention: "遊戲 Retention 趨勢",
    chartGameBetTypePlayers: "遊戲 Bet Type 玩家數",
    axisPlayers: "玩家數",
    axisRtp: "RTP (%)",
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
    rangeLimitError: "時間區間不可超過一個月",
    loading: "載入中...",
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
    logout: "登出"
  }
};

function updateLanguageUI() {
  // 依據當前語系設定更新網頁上的所有文字欄位
  const lang = translations[currentLang];
  document.title = currentLang === 'zh' ? 'iGaming 營運分析平台' : 'iGaming Operations Analytics Platform';
  document.getElementById('login-title').textContent = lang.loginTitle;
  document.getElementById('login-description').textContent = lang.loginDescription;
  document.getElementById('login-password-label').textContent = lang.loginPasswordLabel;
  if (!loginSubmit.disabled) loginSubmit.textContent = lang.loginSubmit;
  btnLogout.textContent = lang.logout;
  
  // 頁首 Header 區塊
  document.getElementById('nav-title').childNodes[0].textContent = lang.title + ' ';
  document.getElementById('nav-subtitle').textContent = lang.subtitle;
  document.getElementById('legend-curve').textContent = lang.legendCurve;
  document.getElementById('legend-fg').textContent = lang.legendFg;
  document.getElementById('legend-gs').textContent = lang.legendGs;
  btnLangToggle.textContent = currentLang === 'zh' ? '繁中 / EN' : 'EN / 繁中';

  document.getElementById('page-nav-title').textContent = lang.navTitle;
  document.getElementById('page-nav-eyebrow').textContent = lang.navEyebrow;
  document.getElementById('page-nav-home').textContent = lang.navHome;
  document.getElementById('page-nav-monthly').textContent = lang.navMonthly;
  document.getElementById('page-nav-game').textContent = lang.navGame;
  document.getElementById('page-nav-player').textContent = lang.navPlayer;

  document.getElementById('home-eyebrow').textContent = lang.homeEyebrow;
  document.getElementById('home-page-title').textContent = lang.homeTitle;
  document.getElementById('home-page-description').textContent = lang.homeDescription;
  document.getElementById('home-month-title').textContent = lang.homeMonthTitle;
  document.getElementById('home-day-title').textContent = lang.homeDayTitle;
  document.getElementById('home-game-ranking-title').textContent = lang.homeGameRankingTitle;
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
    ['Username', lang.totalSpinsLabel, `${lang.totalBet} (IDR)`, `${lang.totalWin} (IDR)`, `${lang.homeProfit} (IDR)`]
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
  document.getElementById('game-label-slot').textContent = lang.labelGame;
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
  Array.from(gameSlotSelect.options).forEach(option => {
    option.textContent = option.value === 'ALL'
      ? lang.allGames
      : lang.gameOption.replace('{name}', option.dataset.gameName || option.value).replace('{slot}', option.value);
  });
  
  // 篩選器面板區塊
  document.getElementById('filter-title').textContent = lang.filterTitle;
  document.getElementById('label-active-player').textContent = lang.labelActivePlayer;
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
  const optPlaceholderPlayer = document.getElementById('opt-placeholder-player');
  if (optPlaceholderPlayer) {
    optPlaceholderPlayer.textContent = lang.placeholderPlayer;
  }
  
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
  if (gameDataCache.length) renderGameCharts(gameDataCache, gameSlotSelect.value || 'ALL');
  if (gameSpinDistributionCache.length && gameSlotSelect.value !== 'ALL') renderGameSpinDistribution(gameSpinDistributionCache);
  if (gameRankingCache.length && gameSlotSelect.value === 'ALL') renderGameRanking();
  if (homeDashboardCache) renderHomeDashboard(homeDashboardCache);
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

function loadAvailableDates() {
  // 自 API /api/dates 獲取可選的分區日期清單，並預設加載首個日期
  fetch('/api/dates')
    .then(res => {
      if (!res.ok) {
        return res.json().then(data => { throw new Error(data.error || translations[currentLang].serverError); });
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

  if (mode === 'range' && isDateRangeOverOneMonth(startDate, endDate)) {
    playerSelect.innerHTML = `<option value="">⚠️ ${translations[currentLang].rangeLimitError}</option>`;
    resetDashboardState();
    return;
  }
  
  loadPlayersForDate(startDate, endDate);
}

let activePlayersList = []; // 用於快取目前加載的玩家 ID 陣列

function markFiltersPending() {
  activePlayersList = [];
  playerSelect.innerHTML = `<option value="" id="opt-placeholder-player">${translations[currentLang].placeholderApplyFilters}</option>`;
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
  resetDashboardState();
  setFilterLoading(true);
  
  fetch(`/api/players?${queryParams.toString()}`, { signal: requestController.signal })
    .then(res => {
      if (!res.ok) {
        return res.json().then(data => { throw new Error(data.error || translations[currentLang].serverError); });
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
  playerSelect.innerHTML = '';
  
  if (activePlayersList.length === 0) {
    const opt = document.createElement('option');
    opt.value = "";
    opt.textContent = translations[currentLang].noPlayers;
    playerSelect.appendChild(opt);
    resetDashboardState();
    return;
  }

  const placeholderOpt = document.createElement('option');
  placeholderOpt.value = "";
  placeholderOpt.id = "opt-placeholder-player";
  placeholderOpt.textContent = translations[currentLang].placeholderSelectPlayer;
  playerSelect.appendChild(placeholderOpt);
  
  activePlayersList.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = translations[currentLang].playerOption.replace('{player}', p);
    playerSelect.appendChild(opt);
  });
  
  // 保留或預設選擇指定玩家 ID
  if (selectPlayerId && activePlayersList.includes(String(selectPlayerId))) {
    playerSelect.value = String(selectPlayerId);
  } else {
    playerSelect.value = "";
  }
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
  tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-secondary); font-weight: bold;">${translations[currentLang].placeholderLoadingPlayers}</td></tr>`;
  
  // 自 API /api/data 獲取指定日期和玩家的投注紀錄，並送入前端進行即時計算
  fetch(`/api/data?${queryParams.toString()}`, { signal: requestController.signal })
    .then(res => {
      if (!res.ok) {
        return res.json().then(data => { throw new Error(data.error || translations[currentLang].serverError); });
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
      bet_at: new Date(record.bet_at),
      slot_id: slotId,
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
  
  const player = playerSelect.value;
  const mode = dateModeSelect.value;
  let dateText = '';
  if (mode === 'single') {
    dateText = dateSelect.value;
  } else {
    dateText = `${dateStartSelect.value} ~ ${dateEndSelect.value}`;
  }
  
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
    const timestampStr = formatDateTimeForTooltip(row.bet_at);
    
    // 投注類型代碼映射為文字字串
    let betTypeStr = '--';
    if (row.bet_type !== undefined && row.bet_type !== null) {
      const bType = Number(row.bet_type);
      if (bType === 1) {
        betTypeStr = lang.betTypeNormal;
      } else if (bType === 2) {
        betTypeStr = lang.betTypeAnte;
      } else if (bType === 3) {
        betTypeStr = lang.betTypeBuy;
      } else {
        betTypeStr = lang.betTypeUnknown.replace('{type}', bType);
      }
    }
    
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
  
  // 渲染 Plotly 圖表
  renderPlotlyChart(analyzedData, player, dateText);
}

function renderPlotlyChart(chartData, player, date) {
  // 使用 Plotly.js 對分析後的數據點進行渲染，包含 Tooltips 進階顯示
  const lang = translations[currentLang];
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
    type: 'scatter'
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
    type: 'scatter'
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
    text: gsDataset.map(r => r.slot_id),
    type: 'scatter'
  };

  // 圖表版面與樣式細部設定 (對齊玻璃擬態 Cyber-Dark 面板風格)
  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(15, 23, 42, 0.4)',
    font: { family: 'Roboto Mono, SFMono-Regular, Consolas, monospace', color: '#94a3b8' },
    margin: { l: 80, r: 40, t: 50, b: 50 },
    title: {
      text: lang.chartTitle.replace('{player}', player).replace('{date}', date),
      font: {
        color: '#f3f4f6',
        family: 'Outfit, sans-serif',
        size: 16
      }
    },
    xaxis: {
      title: lang.chartXAxis,
      gridcolor: 'rgba(255,255,255,0.05)',
      tickfont: { color: '#94a3b8' },
      titlefont: { color: '#94a3b8' },
      zerolinecolor: 'rgba(255,255,255,0.1)'
    },
    yaxis: {
      title: lang.chartYAxis,
      gridcolor: 'rgba(255,255,255,0.05)',
      tickfont: { color: '#94a3b8' },
      titlefont: { color: '#94a3b8' },
      zerolinecolor: 'rgba(255,255,255,0.1)',
      tickformat: ',' // 大金額格式化
    },
    legend: {
      font: { color: '#94a3b8' },
      bgcolor: 'rgba(15, 23, 42, 0.95)',
      bordercolor: 'rgba(255,255,255,0.05)',
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

  const dataTraces = [...profitTraces];
  if (fgDataset.length > 0) dataTraces.push(freeGameTrace);
  if (gsDataset.length > 0) dataTraces.push(gameSwitchTrace);

  Plotly.newPlot('chart-viewport', dataTraces, layout, config);
}

function resetDashboardState() {
  // 重置清空目前指標數據看板、表格與圖表至初始狀態
  analyzedData = [];
  
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
  return lang.betTypeUnknown.replace('{type}', bType);
}

function getBetTypeColor(betType) {
  const bType = Number(betType);
  if (bType === 1) return '#6366f1';
  if (bType === 2) return '#f59e0b';
  if (bType === 3) return '#10b981';
  return '#94a3b8';
}

function formatGameDisplay(slotId, gameName) {
  const name = gameName || String(slotId);
  return translations[currentLang].gameOption
    .replace('{name}', name)
    .replace('{slot}', slotId);
}

function buildChartCustomData(row, lang) {
  return [
    formatCurrency(row.net_profit),
    formatCurrency(row.bet_amount),
    formatCurrency(row.total_prize),
    formatGameDisplay(row.slot_id, row.game_name),
    formatDateTimeForTooltip(row.bet_at),
    getBetTypeLabel(row.bet_type, lang),
    row.player_id
  ];
}

function formatGameNameOnly(slotId, gameName) {
  return gameName || String(slotId);
}

function renderHomeDashboard(data) {
  const lang = translations[currentLang];
  const currentMonth = data.current_month || {};
  const previousMonth = data.previous_month || {};
  const currentDay = data.current_day || {};
  const referenceDate = data.reference_date || data.latest_date || '--';
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
  }], monthlyChartLayout(lang.homeGgr30d, lang.axisGgr), { responsive: true, displaylogo: false, displayModeBar: false });

  const renderGameRows = (bodyId, rows) => {
    document.getElementById(bodyId).innerHTML = rows.length ? rows.map(row => `<tr>
      <td>${escapeHtml(row.game_name || row.slot_id)}</td><td>${formatCount(row.total_spin_count)}</td><td>${formatCount(row.ggr)}</td>
    </tr>`).join('') : `<tr><td colspan="3">--</td></tr>`;
  };
  const renderPlayerRows = (bodyId, rows) => {
    document.getElementById(bodyId).innerHTML = rows.length ? rows.map(row => `<tr>
      <td>${escapeHtml(row.username || row.player_id)}</td><td>${formatCount(row.total_spin_count)}</td><td>${formatCount(row.total_bet_amount)}</td>
      <td>${formatCount(row.total_win_amount)}</td><td class="profit-positive">${formatCount(row.profit)}</td>
    </tr>`).join('') : `<tr><td colspan="5">--</td></tr>`;
  };
  renderGameRows('home-game-7d-body', data.game_rankings?.seven_day || []);
  renderGameRows('home-game-day-body', data.game_rankings?.current_day || []);
  renderPlayerRows('home-player-7d-body', data.player_alerts?.seven_day || []);
  renderPlayerRows('home-player-day-body', data.player_alerts?.current_day || []);
  homeStatus.textContent = '';
}

async function loadHomeDashboard() {
  homeStatus.textContent = translations[currentLang].homeLoading;
  try {
    const response = await fetch('/api/home-dashboard');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Home dashboard API request failed');
    homeDashboardCache = data;
    renderHomeDashboard(data);
  } catch (error) {
    homeStatus.textContent = translations[currentLang].homeLoadError.replace('{message}', error.message);
  }
}

function setMonthlyMode() {
  const mode = monthlyModeSelect.value;
  const comparing = mode === 'compare';
  const periodMode = mode === 'quarter' || mode === 'half-year' || mode === 'year';
  monthlySingleControls.hidden = mode === 'compare';
  monthlyCompareControls.hidden = mode !== 'compare';
  monthlyBetTypePanel.hidden = comparing;
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
  const isPlayer = page === 'player';
  document.querySelector('main').classList.toggle('home-page', isHome);
  document.querySelector('main').classList.toggle('monthly-page', isMonthly);
  document.querySelector('main').classList.toggle('game-page', isGame);
  document.querySelector('main').classList.toggle('player-page', isPlayer);
  homeContent.hidden = !isHome;
  monthlyContent.hidden = !isMonthly;
  gameContent.hidden = !isGame;

  pageNavItems.forEach((item) => {
    const active = item.dataset.page === page;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });

  if (isMonthly && !monthlyMonthSelect.value) {
    loadMonthlyDateDefaults();
  }
  if (isGame && !gameStartDate.value) {
    loadGameDateDefaults();
  }
  if (isHome) loadHomeDashboard();
  saveUiState();
}

function monthlyChartLayout(title, yTitle, extra = {}) {
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(15, 23, 42, 0.4)',
    font: { family: 'Roboto Mono, SFMono-Regular, Consolas, monospace', color: '#94a3b8' },
    margin: { l: 55, r: 20, t: 48, b: 45 },
    title: { text: title, font: { color: '#f3f4f6', size: 15 } },
    xaxis: { gridcolor: 'rgba(255,255,255,0.05)', tickfont: { color: '#94a3b8' } },
    yaxis: { title: yTitle, gridcolor: 'rgba(255,255,255,0.05)', tickfont: { color: '#94a3b8' } },
    legend: { font: { color: '#94a3b8' }, bgcolor: 'rgba(15, 23, 42, 0.85)' },
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
    { x: dates, y: rows.map(r => pct(r.odd_rtp)), name: 'Odd RTP', type: 'scatter', mode: 'lines+markers', line: { color: '#f59e0b', width: 2 } }
  ], monthlyChartLayout(lang.chartDailyRtp, lang.axisRtp, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);

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
    { x: dates, y: rows.map(r => pct(r.retention_1)), name: 'D1', type: 'scatter', mode: 'lines+markers', line: { color: '#10b981' } },
    { x: dates, y: rows.map(r => pct(r.retention_3)), name: 'D3', type: 'scatter', mode: 'lines+markers', line: { color: '#f59e0b' } },
    { x: dates, y: rows.map(r => pct(r.retention_7)), name: 'D7', type: 'scatter', mode: 'lines+markers', line: { color: '#ef4444' } }
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
    xaxis: { title: currentLang === 'zh' ? '日期（日）' : 'Day of Month', dtick: 1 }, ...extra
  });
  Plotly.newPlot('monthly-rtp-chart', traces(r => pct(r.rtp)), layout(lang.chartDailyRtp, lang.axisRtp, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
  Plotly.newPlot('monthly-ggr-chart', traces(r => money(r.total_bet_amount) - money(r.total_win_amount), 'bar'), layout(lang.chartDailyGgr, lang.axisGgr, { barmode: 'group' }), common);
  const dauDnuTraces = Array.from(groups, ([month, monthRows], index) => ([
    { x: monthRows.map(row => Number(row.date.slice(8, 10))), y: monthRows.map(r => Number(r.player_count || 0)), name: `${month} DAU`, type: 'scatter', mode: 'lines+markers', line: { color: colors[index], width: 2 } },
    { x: monthRows.map(row => Number(row.date.slice(8, 10))), y: monthRows.map(r => Number(r.dnu || 0)), name: `${month} DNU`, type: 'scatter', mode: 'lines+markers', line: { color: dnuColors[index], width: 2 } }
  ])).flat();
  const dnuRateTraces = Array.from(groups, ([month, monthRows], index) => ({
    x: monthRows.map(row => Number(row.date.slice(8, 10))),
    y: monthRows.map(r => Number(r.player_count || 0) ? Number(r.dnu || 0) / Number(r.player_count) * 100 : 0),
    name: month, type: 'scatter', mode: 'lines+markers', line: { color: rateColors[index], width: 2 }
  }));
  Plotly.newPlot('monthly-player-chart', dauDnuTraces, layout(lang.chartDauDnu, lang.axisPlayers), common);
  Plotly.newPlot('monthly-dnu-rate-chart', dnuRateTraces, layout(lang.chartDnuRate, lang.axisDnuRate, { yaxis: { ticksuffix: '%', rangemode: 'tozero' } }), common);
  const retentionLayout = label => layout(`${lang.chartRetention} (${label})`, lang.axisRetention, { yaxis: { tickformat: '.1f', ticksuffix: '%' } });
  Plotly.newPlot('monthly-retention-chart', traces(r => pct(r.retention_1)), retentionLayout('D1'), common);
  Plotly.newPlot('monthly-retention-3-chart', traces(r => pct(r.retention_3)), retentionLayout('D3'), common);
  Plotly.newPlot('monthly-retention-7-chart', traces(r => pct(r.retention_7)), retentionLayout('D7'), common);
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
    latestAvailableMonth = latestDate.slice(0, 7);
    monthlyMonthSelect.value = latestAvailableMonth;
    monthlyEndMonth.value = monthlyMonthSelect.value;
    monthlyStartMonth.value = shiftMonth(monthlyEndMonth.value, -5);
    loadMonthlyData();
  } catch (error) {
    monthlyStatus.textContent = translations[currentLang].monthlyDateError;
  }
}

async function loadMonthlyData() {
  clearExpandedMonthlyCube();
  const mode = monthlyModeSelect.value;
  const comparing = mode === 'compare';
  let startRange;
  let endRange;
  if (mode === 'compare') {
    const startIndex = monthIndex(monthlyStartMonth.value);
    const endIndex = monthIndex(monthlyEndMonth.value);
    if (startIndex === null || endIndex === null) return;
    if (startIndex > endIndex) {
      monthlyStatus.textContent = translations[currentLang].monthlyRangeOrderError;
      return;
    }
    if (endIndex - startIndex + 1 > 6) {
      monthlyStatus.textContent = translations[currentLang].monthlyRangeLimitError;
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
  monthlyStatus.textContent = translations[currentLang].monthlyLoading;
  try {
    const response = await fetch(`/api/monthly?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`);
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.error || 'Monthly API request failed');
    if (!rows.length) {
      monthlyStatus.textContent = translations[currentLang].monthlyNoData;
      return;
    }
    monthlyDataCache = rows;
    updateMonthlyMetrics(rows);
    if (comparing) renderMonthlyComparisonCharts(rows);
    else renderMonthlyCharts(rows);
    loadMonthlyGameRanking(startDate, endDate).catch(error => {
      console.error('Failed to load monthly game ranking:', error);
      monthlyGameRankingCache = [];
      renderMonthlyGameRanking();
    });
    monthlyStatus.textContent = translations[currentLang].monthlyLoaded.replace('{start}', startDate).replace('{end}', endDate).replace('{days}', rows.length);
  } catch (error) {
    monthlyStatus.textContent = translations[currentLang].monthlyLoadError.replace('{message}', error.message);
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
        retention_1: 0, retention_3: 0, retention_7: 0, _count: 0
      });
    }
    const target = grouped.get(key);
    ['player_count', 'dnu', 'total_spin_count', 'total_bet_amount', 'total_win_amount',
      'bet_1_player_count', 'bet_2_player_count', 'bet_3_player_count'].forEach(field => {
      target[field] += Number(row[field] || 0);
    });
    ['retention_1', 'retention_3', 'retention_7'].forEach(field => {
      target[field] += Number(row[field] || 0);
    });
    target._count += 1;
  });
  return Array.from(grouped.values()).sort((a, b) => a.date.localeCompare(b.date)).map(row => ({
    ...row,
    retention_1: row.retention_1 / row._count,
    retention_3: row.retention_3 / row._count,
    retention_7: row.retention_7 / row._count,
    rtp: row.total_bet_amount ? row.total_win_amount / row.total_bet_amount : 0
  }));
}

function renderGameCharts(rows, selectedSlot) {
  const lang = translations[currentLang];
  const data = selectedSlot === 'ALL' ? aggregateGameRows(rows) : rows;
  const dates = data.map(row => row.date);
  const pct = value => Number(value || 0) * 100;
  const common = { responsive: true, displaylogo: false, displayModeBar: false };

  if (selectedSlot === 'ALL') {
    const spinByGame = new Map();
    rows.forEach(row => {
      const key = String(row.slot_id);
      if (!spinByGame.has(key)) spinByGame.set(key, { name: row.game_name || key, spins: 0 });
      spinByGame.get(key).spins += Number(row.total_spin_count || 0);
    });
    const rankedGames = Array.from(spinByGame.values()).sort((a, b) => b.spins - a.spins);
    const topGames = rankedGames.slice(0, 10);
    const otherSpins = rankedGames.slice(10).reduce((sum, game) => sum + game.spins, 0);
    if (otherSpins > 0) topGames.push({ name: lang.otherGames, spins: otherSpins });
    Plotly.newPlot('game-player-chart', [{ labels: topGames.map(game => game.name), values: topGames.map(game => game.spins), type: 'pie', textinfo: 'label+percent', hovertemplate: '%{label}<br>Total Spin: %{value:,.0f}<br>%{percent}<extra></extra>', hole: 0.35 }], monthlyChartLayout(lang.chartGameSpinShare, ''), common);
  } else {
    Plotly.newPlot('game-player-chart', [{ x: dates, y: data.map(r => Number(r.player_count || 0)), name: lang.axisPlayers, type: 'scatter', mode: 'lines+markers', line: { color: '#38bdf8', width: 3 } }], monthlyChartLayout(lang.chartGamePlayers, lang.axisPlayers), common);
  }
  Plotly.newPlot('game-ggr-chart', [{ x: dates, y: data.map(r => Number(r.total_bet_amount || 0) - Number(r.total_win_amount || 0)), name: 'GGR', type: 'bar', marker: { color: '#10b981' } }], monthlyChartLayout(lang.chartGameGgr, lang.axisGgr), common);
  Plotly.newPlot('game-rtp-chart', [{ x: dates, y: data.map(r => pct(r.rtp)), name: 'RTP', type: 'scatter', mode: 'lines+markers', line: { color: '#6366f1', width: 3 } }], monthlyChartLayout(lang.chartGameRtp, lang.axisRtp, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
  Plotly.newPlot('game-retention-chart', [
    { x: dates, y: data.map(r => pct(r.retention_1)), name: 'D1', type: 'scatter', mode: 'lines+markers', line: { color: '#10b981' } },
    { x: dates, y: data.map(r => pct(r.retention_3)), name: 'D3', type: 'scatter', mode: 'lines+markers', line: { color: '#f59e0b' } },
    { x: dates, y: data.map(r => pct(r.retention_7)), name: 'D7', type: 'scatter', mode: 'lines+markers', line: { color: '#ef4444' } }
  ], monthlyChartLayout(lang.chartGameRetention, lang.axisRetention, { yaxis: { tickformat: '.1f', ticksuffix: '%' } }), common);
  Plotly.newPlot('game-bet-type-chart', [
    { x: dates, y: data.map(r => Number(r.bet_1_player_count || 0)), name: lang.betTypeNormal, type: 'scatter', mode: 'lines', line: { color: '#6366f1' } },
    { x: dates, y: data.map(r => Number(r.bet_2_player_count || 0)), name: lang.betTypeAnte, type: 'scatter', mode: 'lines', line: { color: '#f59e0b' } },
    { x: dates, y: data.map(r => Number(r.bet_3_player_count || 0)), name: lang.betTypeBuy, type: 'scatter', mode: 'lines', line: { color: '#10b981' } }
  ], monthlyChartLayout(lang.chartGameBetTypePlayers, lang.axisPlayers), common);
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

function clearExpandedGameCube() {
  document.querySelectorAll('.game-analysis-content .monthly-chart-panel.game-cube-expanded')
    .forEach(panel => panel.classList.remove('game-cube-expanded'));
}

function clearExpandedMonthlyCube() {
  document.querySelectorAll('.monthly-analysis-content .monthly-chart-panel.monthly-cube-expanded')
    .forEach(panel => panel.classList.remove('monthly-cube-expanded'));
}

document.querySelectorAll('.monthly-analysis-content .monthly-chart-panel').forEach(panel => {
  panel.addEventListener('click', () => {
    if (!['single', 'compare'].includes(monthlyModeSelect.value)) return;
    document.querySelectorAll('.monthly-analysis-content .monthly-chart-panel').forEach(otherPanel => {
      otherPanel.classList.toggle('monthly-cube-expanded', otherPanel === panel);
    });
  });
});

document.querySelectorAll('.game-analysis-content .monthly-chart-panel').forEach(panel => {
  panel.addEventListener('click', () => {
    document.querySelectorAll('.game-analysis-content .monthly-chart-panel').forEach(otherPanel => {
      otherPanel.classList.toggle('game-cube-expanded', otherPanel === panel);
    });
  });
});

document.addEventListener('click', event => {
  if (!event.target.closest('.game-analysis-content .monthly-chart-panel')) {
    clearExpandedGameCube();
  }
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
    selectedOption = moveSelectByArrow(gameSlotSelect, direction);
    if (selectedOption) showNavigationToast(translations[currentLang].keyboardGameSwitch.replace('{value}', selectedOption.textContent));
  } else if (main.classList.contains('player-page')) {
    selectedOption = moveSelectByArrow(playerSelect, direction);
    if (selectedOption) showNavigationToast(translations[currentLang].keyboardPlayerSwitch.replace('{value}', selectedOption.textContent));
  }
  if (selectedOption) event.preventDefault();
});

function renderGameSpinDistribution(rows) {
  const lang = translations[currentLang];
  const buckets = [
    ['dist_0_10', '[0,10)'], ['dist_10_20', '[10,20)'], ['dist_20_50', '[20,50)'],
    ['dist_50_100', '[50,100)'], ['dist_100_300', '[100,300)'], ['dist_300_500', '[300,500)'],
    ['dist_500_1000', '[500,1000)'], ['dist_1000_plus', '[1000,9999999)']
  ];
  const colors = ['#38bdf8', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899', '#f97316', '#eab308', '#10b981'];
  const dates = rows.map(row => row.date);
  const traces = buckets.map(([key, label], index) => ({
    x: dates,
    y: rows.map(row => Number(row[key] || 0) * 100),
    name: label,
    type: 'bar',
    marker: { color: colors[index] },
    hovertemplate: `${label}: %{y:.2f}%<extra></extra>`
  }));
  Plotly.newPlot('game-spin-distribution-chart', traces, monthlyChartLayout(lang.chartGameSpinDistribution, '%', {
    barmode: 'stack',
    barnorm: 'percent',
    yaxis: { range: [0, 100], ticksuffix: '%', title: '%' }
  }), { responsive: true, displaylogo: false, displayModeBar: false });
}

async function loadGameDateDefaults() {
  try {
    const response = await fetch('/api/dates');
    const dates = await response.json();
    if (!Array.isArray(dates) || !dates.length) return;
    const previousMonth = getPreviousCalendarMonthRange(dates[0]);
    gameStartDate.value = previousMonth.startDate;
    gameEndDate.value = previousMonth.endDate;
    loadGameData();
  } catch (error) {
    gameStatus.textContent = translations[currentLang].gameDateError;
  }
}

async function loadGameData() {
  clearExpandedGameCube();
  const startDate = gameStartDate.value;
  const endDate = gameEndDate.value;
  const selectedSlot = gameSlotSelect.value || 'ALL';
  const rankingRequestId = ++gameRankingRequestId;
  gameSpinDistributionPanel.hidden = true;
  gameRankingPanel.hidden = true;
  if (!startDate || !endDate) return;
  gameStatus.textContent = translations[currentLang].gameLoading;
  try {
    const response = await fetch(`/api/game?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&slot_id=${encodeURIComponent(selectedSlot)}`);
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.error || 'Game API request failed');
    if (!rows.length) {
      gameSpinDistributionCache = [];
      gameRankingCache = [];
      gameStatus.textContent = translations[currentLang].gameNoData;
      return;
    }
    gameDataCache = rows;
    if (selectedSlot === 'ALL') {
      const games = new Map();
      rows.forEach(row => games.set(String(row.slot_id), row.game_name || String(row.slot_id)));
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
        option.textContent = lang.gameOption.replace('{name}', games.get(slot)).replace('{slot}', slot);
        gameSlotSelect.appendChild(option);
      });
      gameSlotSelect.value = slots.includes(current) ? current : 'ALL';
      if (pendingGameSlot && slots.includes(pendingGameSlot)) {
        gameSlotSelect.value = pendingGameSlot;
        pendingGameSlot = '';
        saveUiState();
        loadGameData();
        return;
      }
    }
    updateGameMetrics(rows, selectedSlot);
    renderGameCharts(rows, selectedSlot);
    if (selectedSlot === 'ALL') {
      gameSpinDistributionCache = [];
      gameSpinDistributionPanel.hidden = true;
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
      renderGameSpinDistribution(rows);
    }
    gameStatus.textContent = translations[currentLang].gameLoaded.replace('{start}', startDate).replace('{end}', endDate);
  } catch (error) {
    gameStatus.textContent = translations[currentLang].gameLoadError.replace('{message}', error.message);
  }
}

btnLoadMonthly.addEventListener('click', loadMonthlyData);
monthlyMonthSelect.addEventListener('change', loadMonthlyData);
monthlyModeSelect.addEventListener('change', () => {
  setMonthlyMode();
  loadMonthlyData();
});
monthlyStartMonth.addEventListener('change', loadMonthlyData);
monthlyEndMonth.addEventListener('change', loadMonthlyData);
btnLoadGame.addEventListener('click', loadGameData);
gameSlotSelect.addEventListener('change', loadGameData);
gameStartDate.addEventListener('change', clearExpandedGameCube);
gameEndDate.addEventListener('change', clearExpandedGameCube);
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

[monthlyModeSelect, monthlyMonthSelect, monthlyStartMonth, monthlyEndMonth, gameStartDate, gameEndDate, gameSlotSelect,
  dateModeSelect, dateSelect, dateStartSelect, dateEndSelect, minSpinsInput, maxSpinsInput,
  playerSelect, checkboxNewPlayer, checkboxOldPlayer, checkboxWinPlayer, checkboxLosePlayer,
  btnLangToggle].forEach(element => element.addEventListener('change', saveUiState));

function restoreUiState() {
  restoredUiState = readUiState();
  if (!restoredUiState) return 'player';

  if (restoredUiState.lang === 'en' || restoredUiState.lang === 'zh') currentLang = restoredUiState.lang;
  const monthly = restoredUiState.monthly || {};
  if (['single', 'compare', 'quarter', 'half-year', 'year'].includes(monthly.mode)) monthlyModeSelect.value = monthly.mode;
  if (monthly.month) monthlyMonthSelect.value = monthly.month;
  if (monthly.startMonth) monthlyStartMonth.value = monthly.startMonth;
  if (monthly.endMonth) monthlyEndMonth.value = monthly.endMonth;
  setMonthlyMode();

  const game = restoredUiState.game || {};
  if (game.startDate) gameStartDate.value = game.startDate;
  if (game.endDate) gameEndDate.value = game.endDate;
  pendingGameSlot = game.slot && game.slot !== 'ALL' ? String(game.slot) : '';

  const player = restoredUiState.player || {};
  if (player.dateMode === 'single' || player.dateMode === 'range') dateModeSelect.value = player.dateMode;
  containerSingleDate.style.display = dateModeSelect.value === 'single' ? 'block' : 'none';
  containerRangeDate.style.display = dateModeSelect.value === 'range' ? 'block' : 'none';
  if (player.minSpins !== undefined) minSpinsInput.value = player.minSpins;
  if (player.maxSpins !== undefined) maxSpinsInput.value = player.maxSpins;
  pendingPlayerId = player.playerId ? String(player.playerId) : '';
  ['newPlayer', 'oldPlayer', 'winPlayer', 'losePlayer'].forEach(key => {
    const element = { newPlayer: checkboxNewPlayer, oldPlayer: checkboxOldPlayer, winPlayer: checkboxWinPlayer, losePlayer: checkboxLosePlayer }[key];
    if (typeof player[key] === 'boolean') element.checked = player[key];
  });

  return ['home', 'player', 'monthly', 'game'].includes(restoredUiState.activePage) ? restoredUiState.activePage : 'player';
}

function renderMonthlyGameRanking() {
  const body = document.getElementById('monthly-game-ranking-body');
  const { key, direction } = monthlyRankingSort;
  const rows = [...monthlyGameRankingCache].sort((a, b) => {
    const result = key === 'game_name'
      ? String(a[key] || '').localeCompare(String(b[key] || ''), currentLang === 'zh' ? 'zh-Hant' : 'en')
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
    <td>${String(row.game_name || row.slot_id || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])}</td>
    <td>${formatCount(row.days)}</td>
    <td>${formatCount(row.player_count)}</td>
    <td>${Number(row.avg_spin_count || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    <td>${Number(row.avg_bet_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    <td>${formatCount(row.total_spin_count)}</td>
    <td>${formatCount(row.total_bet_amount)}</td>
    <td>${formatCount(row.total_win_amount)}</td>
    <td>${formatCount(row.ggr)}</td>
  </tr>`).join('');
}

async function loadMonthlyGameRanking(startDate, endDate) {
  const response = await fetch(`/api/game-ranking?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`);
  const rows = await response.json();
  if (!response.ok) throw new Error(rows.error || 'Game ranking API request failed');
  monthlyGameRankingCache = Array.isArray(rows) ? rows : [];
  renderMonthlyGameRanking();
}

function renderGameRanking() {
  const body = document.getElementById('game-ranking-body');
  const { key, direction } = gameRankingSort;
  const rows = [...gameRankingCache].sort((a, b) => {
    const result = key === 'game_name'
      ? String(a[key] || '').localeCompare(String(b[key] || ''), currentLang === 'zh' ? 'zh-Hant' : 'en')
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
    <td>${String(row.game_name || row.slot_id || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])}</td>
    <td>${formatCount(row.days)}</td>
    <td>${formatCount(row.player_count)}</td>
    <td>${Number(row.avg_spin_count || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    <td>${Number(row.avg_bet_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    <td>${formatCount(row.total_spin_count)}</td>
    <td>${formatCount(row.total_bet_amount)}</td>
    <td>${formatCount(row.total_win_amount)}</td>
    <td>${formatCount(row.ggr)}</td>
  </tr>`).join('');
}

async function loadGameRanking(startDate, endDate, requestId) {
  const response = await fetch(`/api/game-ranking?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`);
  const rows = await response.json();
  if (!response.ok) throw new Error(rows.error || 'Game ranking API request failed');
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
  setActivePage(activePage);
  if (activePage === 'monthly' && monthlyMonthSelect.value) loadMonthlyData();
  if (activePage === 'game' && gameStartDate.value && gameEndDate.value) loadGameData();
}

window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
  if (response.status === 401 && !url.includes('/api/auth/')) showLoginScreen();
  return response;
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
