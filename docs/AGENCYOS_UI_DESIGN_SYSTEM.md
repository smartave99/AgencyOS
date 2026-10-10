# AgencyOS — UI/UX Design System & Human Interface Guidelines

**Design Standard:** Apple Consumer Craftsmanship $\times$ Microsoft Enterprise Productivity  
**Framework:** Next.js (App Router), Tailwind CSS, Radix UI Primitives, Lucide / Cohesive SVG Icons, SWR  

---

## 1. Design Philosophy & Core Principles

AgencyOS balances aesthetic restraint with dense, mission-critical productivity:
1. **Generous Whitespace & Purposeful Restraint:** Whitespace is an architectural element, not empty space. Screens breathe, allowing complex campaign metrics to be digested without cognitive fatigue.
2. **Apple-Inspired Craftsmanship:**
   - Subtle border radii (10px–14px for cards and modals, 6px–8px for controls).
   - Minimalist neutral palette: Off-whites, slate grays, subtle 1px borders, and a single purposeful primary accent color per view.
   - Restrained micro-interactions: smooth 150ms transitions on hover and focus. No aggressive bounces or intrusive flashes.
3. **Microsoft Enterprise Workflow Precision:**
   - High information density where needed (tables, audit logs, calendar grids).
   - Instant keyboard navigation: intuitive tab order, Esc to cancel/close modals, Enter to submit.
   - Comprehensive inline validation and informative error messaging.
   - Safety dialogs on all destructive actions (campaign cancellation, destination disconnection).

---

## 2. Color System & Design Tokens

The color tokens adhere to Postiz's Tailwind configuration (`tailwind.config.js` and `global.scss`) to guarantee 100% theme consistency across dark and light modes.

| Token | Light Mode Value | Dark Mode Value | Usage |
| :--- | :--- | :--- | :--- |
| `bg-primary` / `bg-newBgColor` | `#F8FAFC` (Slate 50) | `#0B0F17` (Deep Dark) | App background shell |
| `bg-surface` / `bg-newBgColorInner` | `#FFFFFF` (Pure White) | `#131926` (Navy Dark) | Cards, modals, side panels, dropdowns |
| `border-subtle` / `bg-newBgLineColor`| `#E2E8F0` (Slate 200) | `#1E293B` (Slate 800) | 1px dividers, card outlines, table borders |
| `text-primary` / `text-newTextColor`| `#0F172A` (Slate 900) | `#F8FAFC` (Slate 50) | Headings, primary metrics, active labels |
| `text-secondary` | `#64748B` (Slate 500) | `#94A3B8` (Slate 400) | Subheadings, metadata, helper text |
| `accent-primary` | `#2563EB` (Blue 600) | `#3B82F6` (Blue 500) | Primary CTAs, active tab indicators |
| `status-success` | `#16A34A` (Green 600) | `#22C55E` (Green 500) | Delivered, Approved, Bot Connected |
| `status-warning` | `#D97706` (Amber 600) | `#F59E0B` (Amber 500) | Under Review, Rate Throttled, Expiring |
| `status-danger` | `#DC2626` (Red 600) | `#EF4444` (Red 500) | Failed Delivery, Disconnected, Rejected |

---

## 3. Typography & Information Hierarchy

Typography uses `Plus Jakarta Sans` or system native fonts (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `Inter`):

| Level | Size | Weight | Tracking | Usage |
| :--- | :--- | :--- | :--- | :--- |
| **Display Header** | 24px (1.5rem) | 700 (Bold) | -0.025em | Main Section Title (e.g. "Agency Control Center") |
| **Section Header** | 18px (1.125rem) | 600 (Semibold) | -0.015em | Card titles, modal headers, table titles |
| **Body Primary** | 14px (0.875rem) | 500 (Medium) | Normal | Table cells, form inputs, primary labels |
| **Body Secondary** | 12px (0.75rem) | 400 (Regular) | Normal | Timestamps, helper text, breadcrumbs |
| **Micro Badge** | 11px (0.6875rem) | 600 (Semibold) | +0.025em | Status tags, count indicators, platform badges |

---

## 4. Key UI Components & Layout Blueprints

### 4.1 Top Navigation & Agency Workspace Bar
- Quick tenant/agency switcher with logo and client dropdown.
- Single-click action buttons: `+ New Campaign`, `Onboard Client`, `Verify Destination`.
- Notifications inbox indicator with unread count badge.

### 4.2 Executive KPI Card Anatomy
```
┌────────────────────────────────────────────────────────┐
│ ACTIVE CAMPAIGNS                                 [ ↗ ] │
│ 24 Running                                             │
│ +4 vs last month • 92% on-schedule                     │
│ ▃▄▆█▇▆▅ (sparkline trend)                              │
└────────────────────────────────────────────────────────┘
```

### 4.3 Campaign Creation Wizard Flow
- **Left Panel:** 5-step numbered progress stepper (`1. Brief`, `2. Creative`, `3. Destinations`, `4. Schedule`, `5. Review & Submit`).
- **Center Canvas:** Clean form fields with autosave indicators (`"Saved 3s ago"`).
- **Right Panel:** Live Destination Mockup:
  - Real-time Telegram message preview simulating Telegram desktop/mobile bubble with parsed HTML tags, media layout, and CTA button.
  - Social media mockups (LinkedIn card, X post format).

### 4.4 Manager Approval Queue
- Side-by-side or stacked diff:
  - Client details and budget metrics on the left.
  - Interactive preview and destination target list on the right.
- Decision footer: `Request Changes` (opens feedback dialog) and `Approve & Schedule` (prompts confirmation).

### 4.5 Telegram Destination Registry Card
- Status badge (`Verified Admin` / `Action Required`).
- Chat Title, Type (Supergroup / Channel), Member count estimate.
- Bot capability badges: `Can Post` (green), `Can Delete` (green).
- Last successful delivery timestamp and direct link to Telegram chat.

---

## 5. Interaction Standards & Accessibility (a11y)

1. **Zero-Click Dead Ends:** Every empty state (e.g., no campaigns, no clients) features an informative illustration, a succinct explanation, and a clear primary action button (e.g., `"Create Your First Campaign"`).
2. **Keyboard Traversal:** Complete keyboard support across forms, drawers, and modal dialogs (`Tab`, `Shift+Tab`, `Space`, `Enter`, `Escape`).
3. **Contrast Compliance:** All text tokens meet WCAG 2.1 AA minimum contrast standards (4.5:1 for normal text, 3:1 for large text) across both dark and light themes.
