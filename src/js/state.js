// Shared mutable state — all modules import S and access via S.xxx
const S = {
  // Data arrays
  ACCOUNT_DATA: [],
  CUSTOMER_DATA: [],
  CONFLICTS: [],

  // Map & layers
  map: null,
  stratLayer: null,
  custLayer: null,
  proxLayer: null,
  confLayer: null,
  confProxLayer: null,

  // View / filter state
  currentView: 'accounts',
  selectedTeam: '',
  selectedRep: '',
  selectedStages: new Set(),
  filters: {},
  proximityOn: false,
  proxShowAll: false,
  proxSelectedCustomer: null,
  proxLastClickedCustomer: null,
  proxNearbyListMode: false,
  proxSelectedAccount: null,
  PROXIMITY_MILES: 50,
  adaFilterOn: false,
  welcomeActive: true,
  savedViewState: {},

  // Account list state
  markerLookup: {},
  filteredAccountData: [],
  filteredCustData: [],
  accountListSort: 'enrollment_desc',
  accountListGroupBy: null,
  accountListOpen: false,
  collapsedGroups: {},
  accountListDisplayLimit: 200,

  // Conference state
  CONFERENCE_DATA: [],
  conferencesOn: false,
  confRangeMode: 'all',
  confDateFrom: null,
  confDateTo: null,
  filteredConfData: [],

  // DOM element cache (set in initMap)
  _elSearchInput: null,
  _elPipelinePanel: null,
  _elAdTrigger: null,
  _elSearchAutocomplete: null,
  _elCountBadge: null,
  _elProxBadge: null,
  _elAdOverlay: null,

  // Marker pool
  _markerPool: new Map(),
  _markerPoolBuilt: false,
  _previouslyVisiblePoolKeys: new Set(),

  // Note index cache
  _accountsWithNotes: new Set(),

  // Search state
  lastSearchResults: [],
  searchExactMatch: false,
  acSelectedIndex: -1,
  acItems: [],
  _searchDebounceTimer: null,

  // Action dashboard
  actionDashboardOpen: false,

  // Customer grid cache
  _custGrid: null,
  _custGridMiles: null,

  // Modal state
  currentModalData: null,

  // Performance indices
  _custByName: new Map(),
  _repToTeam: {},
  _teamRepsSet: {},
  _repToAccounts: {},
  _teamToAccounts: {},
  _overlapCount: 0,
  _uniqueCache: {},
  _autocompleteCache: null,
  _accountRepsCache: null,

  // Merge state
  sfdcDataType: 'accounts',
  _userSelectedType: false,
  pendingMergeData: null,
  pendingMergeStats: null,
  pendingAccountMerge: null,
  pendingCustomerMerge: null,
  mergeHasTypeSplit: false,

  // Conflict state
  conflictsOverlayOpen: false,
  conflictResolveAuthed: false,

  // Data refresh state
  dataRefreshAuthed: false,

  // Data source tracking
  _dataSource: 'bundled',

  // Refs to functions set by app.js (avoids circular deps for critical callbacks)
  _applyFilters: null,
  _rebuildMarkerPool: null,
  _ensurePopup: null,
  _openAccountModalByKey: null,
  _renderAccountList: null,
  _updatePipeline: null,
  _updateLegend: null,
  _readSpreadsheetFile: null,
  _saveDataToLocalStorage: null,
  _rebuildNoteIndex: null,
};

export default S;
