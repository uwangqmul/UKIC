export const PROFILE_URL = "https://umushroom.com/en/my-profile";
export const SELECTORS = Object.freeze({
  portfolios: ".profile-primary-portfolios.profile-portfolios",
  listView: ".profile-page .switch-view > a",
  portfolioLinks: "a.title-link[href], a.modern-item-link[href]",
  showMore: "button.profile-list-toggle",
  sections: 'nav.portfolio-section-nav[aria-label="Portfolio sections"] button.section-nav-link',
  periods: '.performance .period-selector[aria-label="Chart period selector"] button.filter-item',
  holdings: ".holdings-workspace .workspace-tabs button.workspace-tab",
  history: "button.summary-action",
  historyPopup: ".transactions-popup",
  historyFilters: ".transactions-popup .transactions-filters button.filter-chip",
  historyClose: '.transactions-popup > .head [role="button"][aria-label="Close popup"]',
  investments: ".holdings-workspace .investments",
  expandHoldings: "button.more-instruments-button:not(.collapse)",
  collapseHoldings: "button.more-instruments-button.collapse",
  sortHoldings: ".investments-table > .titles > span:not(.actions) > .title-header",
});

// Portfolio routes and scoped controls verified in UMushroom's public frontend
// Profile-WJc7G0SY.js / Portfolio-EW4t6_E3.js (2026-09-27).
export function portfolioUrl(href) {
  try {
    const url = new URL(href, PROFILE_URL);
    if (url.origin !== "https://umushroom.com" || url.username || url.password) return null;
    if (!/^\/en\/[^/]+\/[^/]+\/portfolio\/[^/]+\/?$/.test(url.pathname)) return null;
    if (url.search) return null;
    if (/(?:^|\/)(?:new|create|edit|delete|settings|trade)(?:\/|$)/i.test(url.pathname)) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

export function uniquePortfolios(links) {
  const found = new Map();
  for (const link of links) {
    const url = portfolioUrl(link.href);
    if (url && !found.has(url)) found.set(url, { name: link.name.trim() || "Unnamed portfolio", url, href: link.href });
  }
  return [...found.values()];
}
