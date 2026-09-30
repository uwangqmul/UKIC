// =============================================================================
// UMushroom site knowledge: URLs, page selectors and portfolio URL rules
// -----------------------------------------------------------------------------
// Selectors were verified on 2026-09-27 against the real logged-in pages and the site's front-end (Profile / Portfolio modules).
// When a site redesign breaks the automation, this is usually the only file that needs changing.
// =============================================================================

/** URLs */
export const ORIGIN = "https://umushroom.com";
export const HOME_URL = `${ORIGIN}/`;
export const OVERVIEW_URL = `${ORIGIN}/en/my-overview`;
export const PROFILE_URL = `${ORIGIN}/en/my-profile`;

/** Page selectors */
export const SELECTORS = Object.freeze({
  // ---- My profile: the user's portfolio list ----
  portfolios: ".profile-primary-portfolios.profile-portfolios",    // the "You's portfolios" section
  listView: ".profile-page .switch-view > a",                      // card / list view switch
  portfolioLinks: "a.title-link[href], a.modern-item-link[href]",  // portfolio card links
  showMore: "button.profile-list-toggle",                          // Show more / Show less

  // ---- Portfolio page: controls used by the read-only review ----
  sections: 'nav.portfolio-section-nav[aria-label="Portfolio sections"] button.section-nav-link',
  periods: '.performance .period-selector[aria-label="Chart period selector"] button.filter-item',
  holdings: ".holdings-workspace .workspace-tabs button.workspace-tab",  // All / Equities / Pending Orders
  history: "button.summary-action",                                      // the HISTORY button
  historyPopup: ".transactions-popup",
  historyFilters: ".transactions-popup .transactions-filters button.filter-chip",
  historyClose: '.transactions-popup > .head [role="button"][aria-label="Close popup"]',
  investments: ".holdings-workspace .investments",
  expandHoldings: "button.more-instruments-button:not(.collapse)",
  collapseHoldings: "button.more-instruments-button.collapse",
  sortHoldings: ".investments-table > .titles > span:not(.actions) > .title-header",

  // ---- Portfolio page: areas read by journal snapshots ----
  portfolioTitle: ".portfolio-header .title-holder form.editable-title input",  // portfolio name (read-only input)
  portfolioHeader: ".portfolio-header",                    // currency, publish date, public/private
  summaryRail: ".portfolio-summary-rail",                  // right-hand summary: current value, cash, metrics
  workspaceTab: ".holdings-workspace .workspace-tab",      // All / Equities / Pending Orders tabs
  investmentGroup: ".investments-items .investments",      // holding groups (Equities, Funds, ...)
  investmentRow: ".investments-list .investment",          // one holding row
  pendingRow: ".pending-orders-list .investment",          // one pending-order row
  historyCard: ".transactions-popup article.transaction-card",  // a History card (entries grouped by date)

  // ---- Buy / sell ----
  searchTrigger: "button.search-modal-trigger",           // top search box (Ctrl+K)
  searchResult: 'a.suggestion[role="option"]',            // search results (portfolios, users and securities)
  addToPortfolio: "button.add-to-portfolio.primary-add",  // "Add to portfolio" on a security page
  buyPopup: ".popup-box.security-buy-popup",              // buy popup
  sellPopup: ".popup-box.portfolio-sell-popup",           // sell popup
  popupClose: '.head [aria-label="Close popup"]',
  existingTab: '[role="tab"]',                            // the "Add to existing portfolio" tab
  portfolioSelect: '.custom-select[role="combobox"]',     // portfolio drop-down
  portfolioOption: '.select-dropdown [role="option"]',
  sharesInput: ".share-stepper input",                    // number of shares
  amountInput: ".amount-control input",                   // estimated amount
  weightInput: ".weight-input-row input",                 // expected weight
  submit: "button.trade-primary-action",                  // Add / Sell submit button
  holdingRow: ".investments .investment",                 // one holding row in a portfolio
  holdingSell: "button.action-icon-btn.sell",             // the Sell button of a holding row
});

/**
 * Normalise a portfolio link to a full URL; returns null unless it is a portfolio page the user can view.
 * Rule: must be umushroom.com /en/<type>/<name>/portfolio/<id> without a query string,
 * and must not be a new/create/edit/delete/settings/trade address that changes data.
 */
export function portfolioUrl(href) {
  try {
    const url = new URL(href, PROFILE_URL);
    if (url.origin !== ORIGIN || url.username || url.password) return null;
    if (!/^\/en\/[^/]+\/[^/]+\/portfolio\/[^/]+\/?$/.test(url.pathname)) return null;
    if (url.search) return null;
    if (/(?:^|\/)(?:new|create|edit|delete|settings|trade)(?:\/|$)/i.test(url.pathname)) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

/** De-duplicate by normalised URL, keeping the first name seen; nameless entries become "Unnamed portfolio". */
export function uniquePortfolios(links) {
  const found = new Map();
  for (const link of links) {
    const url = portfolioUrl(link.href);
    if (url && !found.has(url)) found.set(url, { name: link.name.trim() || "Unnamed portfolio", url, href: link.href });
  }
  return [...found.values()];
}
