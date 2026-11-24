# AskSales.ai — Complete Visual/UI Research Report

> **Purpose:** Client-facing UI/UX documentation for the AskSales.ai platform  
> **Scope:** All major pages and components across public, dashboard, admin, and support interfaces  
> **Generated from:** Source code analysis of `client/src/` directory

---

## Table of Contents

1. [Landing Page](#1-landing-page)
2. [Public Header & Footer](#2-public-header--footer)
3. [Login & Register Pages](#3-login--register-pages)
4. [Pricing Page](#4-pricing-page)
5. [Dashboard Layout (Shell)](#5-dashboard-layout-shell)
6. [Dashboard Home](#6-dashboard-home)
7. [Chat / Conversations Interface](#7-chat--conversations-interface)
8. [Email Outreach](#8-email-outreach)
9. [Leads Page](#9-leads-page)
10. [Content Calendar](#10-content-calendar)
11. [Settings Page](#11-settings-page)
12. [Admin Dashboard Home](#12-admin-dashboard-home)
13. [Admin Users Management](#13-admin-users-management)
14. [Support Agent Dashboard](#14-support-agent-dashboard)
15. [Billing & Integrations](#15-billing--integrations)
16. [Global Design System](#16-global-design-system)

---

## 1. Landing Page

**Route:** `/` (root)  
**File:** `client/src/app/page.tsx`  
**Wrapper:** `<PublicLayout>` (shared header + footer)

### Page Structure (top to bottom)

1. **Scroll Progress Bar** — Fixed at top of viewport. Framer Motion `scaleX` animation with spring physics. Primary purple color. Tracks page scroll position in real-time.

2. **Hero Section** (`components/landing/Hero.tsx`)
   - **Dimensions:** Full viewport height (`min-h-[90vh]`), centered content with `max-w-5xl`
   - **Background Composition** (layered, bottom to top):
     - Animated radial gradients using CSS: primary purple (`rgba(124, 92, 230, 0.15)`), violet (`rgba(139, 92, 246, 0.1)`), and pink (`rgba(236, 72, 153, 0.05)`) — positioned at different viewport quadrants
     - Noise texture overlay at 3% opacity
     - Subtle dot grid pattern with radial mask (fades at edges)
   - **Badge:** Rounded-full pill at top — `"AI-Powered Sales Automation"` with Zap icon (yellow), pulse animation on the icon
   - **Headline:** `"Just Ask AskSales.ai"` — Responsive sizing from `text-6xl` (mobile) to `text-9xl` (desktop). The word `"Ask"` is styled with:
     - Gradient text (`bg-gradient-to-r from-primary via-violet-400 to-pink-400`)
     - Italic serif font (`font-serif italic`)
     - `bg-clip-text text-transparent` for gradient text effect
   - **Subtitle:** `"The world's first conversational operations agent that runs your business. Just ask, and it gets done."` — `text-xl`, muted foreground color, `max-w-2xl`
   - **Prompt Mockup Interface:**
     - Glossy rounded search bar container with inner shadow
     - Search icon (left side, muted color)
     - Auto-cycling typewriter effect with 6 rotating prompts:
       1. "Find 50 SaaS founders in Bangalore..."
       2. "Create a LinkedIn outreach campaign..."
       3. "Generate landing page copy for..."
       4. "Analyze competitor pricing for..."
       5. "Draft email sequence for cold outreach..."
       6. "Build an ICP for my fintech startup..."
     - Animated cursor border effect during typing
     - Below the bar: Clickable tag chips/pills: `"Generate Lead Report"`, `"Create Ad Campaign"`, `"Draft Email"`, `"Analyze Competitors"` — rounded-full, hover with scale/color transition
   - **CTA Buttons:**
     - "Register" — Primary filled, `rounded-full`, shadow, hover glow
     - "Operations Demo" — Outline variant, `rounded-full`
   - **Glassmorphism Effects:** Container has subtle backdrop blur and semi-transparent backgrounds

3. **Logo Marquee** (`components/landing/LogoMarquee.tsx`)
   - **Header:** `"Empowering High-Growth Teams Globally"` — centered, muted text
   - **Marquee:** 16 company logos (text-based representations, not images), displayed in continuous horizontal auto-scroll
   - **Styling:** Logos in grayscale by default → color on hover (`opacity-50 hover:opacity-100` transition)
   - **Edge Treatment:** CSS gradient fade on left and right edges for seamless infinite scroll illusion
   - Marquee speed is CSS animation-based (not JS-driven)

4. **Meet Agents** (`components/landing/MeetAgents.tsx`)
   - **Section Title:** `"Meet Your AI Team"` with subtitle
   - **Grid:** 4-column layout on `lg:`, 2-column on `md:`, 1-column on mobile
   - **Agent Cards** (data-driven from `agentsData` config):
     - Top: Colored icon background (each agent has unique color — blue, purple, pink, orange, etc.)
     - Agent name in bold
     - Role/title in `uppercase tracking-widest text-xs` (design system label style)
     - Description paragraph
     - 3 feature bullet points with check icons
     - **Hover interactions:**
       - Card lifts (`translate-y-[-4px]`)
       - Shadow increases
       - `"Hire [Agent Name]"` CTA button slides up from bottom with fade-in
     - Links to `/agents/[slug]` detail pages
   - **Animation:** Framer Motion `whileInView` with staggered fade-in (each card delays slightly)

5. **Features Section** (`components/landing/Features.tsx`)
   - **Headline:** `"Build a One-Person Multimillion-Rupee Company"` — large bold text
   - **Subtitle:** Descriptive text about the platform capabilities
   - **Grid:** 3-column layout on `lg:`, responsive down to single column
   - **6 Feature Cards:**

     | Feature | Icon Color | Description |
     |---------|-----------|-------------|
     | Hire Instantly | Blue | Deploy AI agents in seconds |
     | Works 24/7 | Violet | Non-stop autonomous operations |
     | Specialized by Role | Pink | Each agent has domain expertise |
     | Lightning-Fast | Orange | Parallel execution across tasks |
     | Predictable & Scalable | Emerald | Consistent output quality |
     | Multi-Language | Cyan | Global market reach |

   - Each card: `rounded-2xl` with subtle border, colored icon in rounded container, title, description
   - **Animation:** Staggered fade-in on scroll (`whileInView` with `staggerChildren`)

6. **CTA Section** (`components/landing/CTA.tsx`)
   - **Container:** Centered glassmorphism card with `rounded-[3rem]`, gradient overlay (primary to violet)
   - **Headline:** `"Hire Your AI Team Instantly Today"` — gradient text effect
   - **Two CTAs:**
     - `"Build Your Digital Team"` — Primary filled button
     - `"View Pricing Plans"` — Outline/ghost button
   - **Decorative Elements:**
     - Floating rounded rectangles with blur→clear on hover
     - Pulsing background gradient blobs (purple/pink/violet)
     - Subtle particle/shimmer effect

### Landing Page Animations Summary
- Spring-based scroll progress bar
- Typewriter cycling effect in hero
- Staggered card entrance animations
- Hover lift + shadow transitions
- Infinite marquee scroll
- Floating decorative element animations
- `AnimatePresence` for smooth page-level transitions

---

## 2. Public Header & Footer

### Header (`components/PublicHeader.tsx`)

**Position:** Fixed top, full width, z-index high  
**Background:** Glassmorphism — `bg-background/60 backdrop-blur-xl`  
**Height:** `h-20` (80px)

**Left Section:**
- Logo: Custom SVG icon + `"AskSales.ai"` text in **italic serif** font
- Logo has hover scale effect

**Center Navigation:**
- **Home** — Simple link
- **Agents** — Dropdown trigger → **Mega-menu** with `rounded-[2.5rem]`:
  - 2-column grid layout
  - Each cell: Agent icon (colored), agent name, brief description
  - All agent types listed (Lead Gen, Content, Outreach, Performance Marketing, etc.)
  - Subtle background hover on each agent card
- **Pricing** — Simple link

**Right Section:**
- **Theme Toggle:** Sun/Moon icon button (switches between light/dark mode via `next-themes`)
- **Auth-dependent:**
  - *Logged out:* "Login" button (outline) + "Get Started" button (primary)
  - *Logged in:* Profile dropdown with user avatar/initials, name, logout option, dashboard link

**Mobile:**
- Hamburger menu icon (replaces center nav)
- Slide-in mobile menu panel

### Footer (`components/BigFooter.tsx`)

**Layout:** 12-column CSS grid

| Column Span | Content |
|-------------|---------|
| 5 cols | **Brand:** Logo, tagline, social media icons |
| 2 cols | **Platform:** Product links (Features, Pricing, Agents, etc.) |
| 2 cols | **Solutions:** Use-case links (Lead Gen, Email Outreach, etc.) |
| 3 cols | **Company:** About, Contact, Privacy Policy, Terms, Refund Policy, Cancellation Policy |

**Social Icons:** Twitter, LinkedIn, GitHub, Instagram — styled as rounded square buttons with hover background color change

**Bottom Bar:** Full-width separator line, copyright text centered

---

## 3. Login & Register Pages

### Login (`/login`)

**File:** `client/src/app/login/page.tsx`

**Layout:** Split-screen 50/50 horizontal (left panel hidden on mobile)

**Left Panel:**
- Full-height background image with gradient overlay (`from-primary/80 to-black/90`)
- Subtle grid pattern overlay (repeating lines)
- Logo positioned top-left corner
- Large headline: `"Scale Your Revenue with AI Agents"` — white text, bold
- 3 feature chips/badges below headline:
  - "Multi-Channel Outreach"
  - "AI-Powered Leads"
  - "Smart Automation"
- Each chip: rounded-full, semi-transparent white background, white text

**Right Panel (Form):**
- Centered vertically and horizontally
- `"Welcome Back"` heading — `text-3xl font-bold`
- `"Sign in to your account"` subtitle — muted text
- **Form Fields:**
  - Email input: `rounded-2xl` with inner shadow, icon left
  - Password input: `rounded-2xl` with inner shadow, icon left, show/hide toggle
- **Controls:**
  - "Remember me" checkbox (left)
  - "Forgot password?" link (right) — muted text, hover underline
- **Submit Button:** Full-width, primary color, `rounded-2xl`, "Sign In" text
- **Footer:** "Don't have an account? Register" link

**Animations:**
- Framer Motion `motion.div` on right panel: fade + slide up entrance
- Form fields: staggered entrance delay

### Register (`/register`)

**File:** `client/src/app/register/page.tsx`

**Layout:** Same split-screen design as login

**Left Panel:** Same structure, headline changes to `"Create Your Account"`

**Right Panel (Form):**
- `"Get Started"` heading
- `"Create your account to begin"` subtitle
- **Form Fields:**
  - Full Name: `rounded-2xl` input
  - Email: `rounded-2xl` input
  - Password: `rounded-2xl` input with show/hide
  - Confirm Password: `rounded-2xl` input with show/hide
- **Submit Button:** Full-width primary, "Create Account"
- **Footer:** "Already have an account? Sign In"

**Success State:**
- `AnimatePresence` modal overlay
- Success icon (checkmark in circle)
- "Account Created!" message
- Auto-redirect to `/verify-email` after 4-second countdown (shown to user)
- Manual "Go to Verification" button

---

## 4. Pricing Page

**Route:** `/pricing`  
**File:** `client/src/app/pricing/page.tsx`

### Hero Section
- Large headline with gradient text
- Subtitle about pricing plans

### Pricing Cards (3-column grid)

| Plan | Price | Visual Treatment |
|------|-------|-----------------|
| **Starter** | Free | Standard card, neutral border |
| **Professional** | ₹3,999/mo | `scale-105`, primary border, primary shadow, "Recommended" badge with Sparkles icon |
| **Enterprise** | Custom | Standard card, "Contact Us" CTA |

**Card Structure:**
- Plan icon (top)
- Plan name (bold)
- Price (large text, with `/month` suffix)
- Feature checklist: Check icons (green) + feature text, multiple items
- CTA button at bottom:
  - Starter: "Get Started Free" (outline)
  - Professional: "Start Free Trial" (primary filled)
  - Enterprise: "Contact Sales" (outline)

### FAQ Section
- Below pricing cards
- Accordion-style Q&A (click to expand/collapse)
- Questions about billing, features, cancellation, etc.

### Background
- Decorative blurred gradient blobs (purple/violet/pink) positioned absolutely behind content
- Similar aesthetic to landing page CTA section

---

## 5. Dashboard Layout (Shell)

**File:** `client/src/components/DashboardLayout.tsx`

### Overall Structure
```
┌─────────────────────────────────────────────┐
│                   Header                     │
├──────────┬──────────────────────────────────┤
│          │                                   │
│ Sidebar  │          Main Content             │
│ (280px   │          (flex-1)                 │
│  or 88px)│                                   │
│          │                                   │
└──────────┴──────────────────────────────────┘
```

### Sidebar — Expanded (280px)

**Background:** `bg-background/80 backdrop-blur-2xl`  
**Border:** Right border with `border-border/40`  
**Shadow:** `shadow-2xl shadow-black/5`  
**Transition:** `duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]` (smooth spring-like)  
**Height:** `h-[calc(100vh-72px)]` (below header) on mobile, full height on desktop

**Navigation Sections** (config-driven from `sidebarConfig`):

| Section | Icon | Navigation Children |
|---------|------|-------------------|
| Campaigns | MessageSquare | New Campaign link + dynamic chat thread list |
| Lead Agent | Users/Target | Lead management views |
| Content Agent | Palette/Pen | Content studio views |
| Performance Marketing | TrendingUp | Ad campaigns, analytics |
| Outreach Agent | Send | Multi-channel outreach |
| Integrations | Plug | Platform connections |
| Settings | Settings | App configuration |
| CRM | Database | Customer records |
| Support | Headphones | Support tickets |
| Proposals | FileText | Proposal management |

**Section Item Design (expanded):**
- **Section header button:** Full-width, `rounded-2xl`, flex row
  - Left: Icon in `p-2 rounded-xl` container (active: `bg-primary text-primary-foreground shadow-lg shadow-primary/30`, hover: `scale-110`)
  - Center: Label in `font-bold text-xs uppercase tracking-widest`
  - Right: ChevronDown (rotates 180° on expand)
- **Active section:** `bg-primary/5 text-primary`
- **Expanded children:**
  - Indented with `ml-7`, `border-l-2 border-primary/10`
  - Each item: Small dot indicator (active: `bg-primary shadow-[0_0_8px] scale-150`), `text-[13px] font-medium`
  - Active item: `text-primary font-black scale-[1.02]`
  - Hover: `translate-x-1` slide effect
- **Campaigns section special:** Shows dynamic chat threads list, "New Campaign" with Plus icon, "View All" with Eye icon and total count

**Bottom Navigation:** Flat non-collapsible links separated by `border-t border-primary/5`

**Collapse Toggle:** Button at bottom with PanelLeftClose icon

### Sidebar — Collapsed (88px)

- Icon-only navigation (section icons centered)
- Active: `bg-[#f3e8ff] dark:bg-[#6d3fa0]/40 text-[#6b21b6]`
- Tooltip via `title` attribute on each link
- Expand button at bottom with PanelLeftOpen icon

### Main Content Area

- `flex-1 overflow-auto`
- **Background:** `bg-background/30 backdrop-blur-sm`
- **Top gradient:** Absolutely positioned `h-64 bg-gradient-to-b from-primary/5 to-transparent`
- **Padding:** `p-8` for most pages, `p-0` for chat/outreach/conversations pages
- **Breadcrumbs:** Shown on all pages except chat, outreach, conversations, support-ai

### Mobile Behavior
- Sidebar becomes overlay (fixed, z-40)
- Dark backdrop overlay (`bg-black/50`) behind sidebar
- Click backdrop to close

---

## 6. Dashboard Home

**Route:** `/dashboard/home`  
**File:** `client/src/app/dashboard/(main)/home/page.tsx`

### Header Area
- **Title:** Dynamic based on active tab:
  - Chat: `"What would you like to work on today?"`
  - Dashboard: `"Welcome back, {userName}!"`
- **Subtitle:** Contextual description
- **Tab Toggle:** Pill-shaped toggle bar (`bg-muted rounded-xl p-1 shadow-sm border`)
  - "Chat" button with MessageCircle icon
  - "Dashboard" button with LayoutDashboard icon
  - Active tab: `bg-primary text-primary-foreground shadow-sm`

### Chat Tab

**Layout:** Centered column, `min-h-[60vh]`, `max-w-4xl mx-auto`

**Command Input Bar:**
- Width: `max-w-2xl`
- Shape: `rounded-[35px]`
- Height: `py-5` (tall input)
- Shadow: `shadow-[0_4px_20px_-2px_rgba(0,0,0,0.1)]` (light), `shadow-[0_4px_20px_-2px_rgba(0,0,0,0.3)]` (dark)
- Left icon: Plus sign (muted, transitions to primary on focus)
- Placeholder: `"On your command!"`
- Font size: `text-lg`
- **Right side controls:**
  - Mic button: `rounded-full`, turns red with `animate-pulse` when listening (Web Speech API)
  - Send button: `rounded-full`, `bg-gradient-primary`, white icon, `active:scale-95`

**Business Profile Selector:**
- Appears below input if user has multiple profiles
- `"Profile:"` label + Select dropdown (`rounded-xl`, `border-primary/20 bg-primary/5`)

**Suggestion Marquee:**
- 3 rows of auto-scrolling suggestion pills
- Row animations: forward, reverse, slow (different CSS animation classes)
- Each pill: `rounded-full`, `bg-purple-lighter text-primary`, `border border-purple-light shadow-sm`
- Click → creates chat thread and navigates to conversation
- Items duplicated for seamless infinite loop effect
- Fade masks on edges

### Dashboard Tab

**Stats Grid** (4 columns on md+):

| Card | Icon | Value Format | Subtitle |
|------|------|-------------|----------|
| Total Leads | Users | Number | "{N} new leads" |
| Active Campaigns | BarChart3 | Number | "{N} completed" |
| Conversion Rate | TrendingUp | Percentage | "From total leads" |
| Total Spent | IndianRupee | ₹{N} | "Of ₹{N} budget" |

Each card: `CardHeader` with icon + label, `CardContent` with `text-2xl font-bold` value + `text-xs text-muted-foreground` subtitle.

**Quick Actions Card:**
- "Start New Campaign" — Primary button → `/dashboard/conversations`
- "View All Campaigns" — Outline button → `/dashboard/chats`

**Recent Agent Runs** (Card with Activity icon header):
- List of campaign thread entries, each as a `rounded-lg border` row:
  - Left: `h-9 w-9 rounded-lg bg-gradient-to-br from-primary` square icon
  - Title: Campaign name or thread title (truncated)
  - Agent badge: Colored by type (default/secondary/outline/destructive variants)
  - Timestamp: Relative date ("Today at 2:30 PM", "Yesterday", "3 days ago")
  - ICP Fit Score badge (conditional): Green ≥70%, Amber ≥50%, Red <50%
  - **Mini stat icons row:**
    - 👥 Leads count (purple-600)
    - 📄 Content count (blue-600)
    - 📢 Ad copies count (orange-600)
    - ✉️ Outreach count (green-600)
- Empty state: MessageSquare icon + "No agent runs yet" text

**Charts Section** (3-column grid on md+):

1. **Daily Activity Area Chart** (spans 2 columns):
   - Recharts `AreaChart` + `ResponsiveContainer`
   - 300px height
   - Gradient fill under curve (primary color, 80% to 10% opacity)
   - Shows leads, messages, conversions over 7 days
   - Tooltip + grid lines

2. **Lead Sources Pie Chart** (1 column):
   - Recharts `PieChart`
   - Color palette: primary, secondary, tertiary + additional colors
   - Legend below

3. **Channel Comparison Bar Chart:**
   - Grouped bars: Email, SMS, LinkedIn
   - Metrics: Sent, Opened/Delivered, Replied
   - Color scheme: `#7c5ce6`, `#b48cf2`, `#f6a6c1`

4. **Campaign Performance:**
   - Bar chart showing campaign-level metrics

### User Setup Check
- On mount, checks for business profiles and brand toolkits
- Redirects to `/dashboard/settings/company` if no business profile exists
- Redirects to `/dashboard/brand-toolkit` if no brand toolkit exists

---

## 7. Chat / Conversations Interface

**Route:** `/dashboard/conversations/[[...threadId]]`  
**File:** `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx`  
**~3,000 lines** — Most complex page in the application

### Architecture
Wrapped in `WorkflowProvider` → `AgentProvider` → `ChatContent` component.

### Layout Structure
```
┌──────────────────────────────────────────────────┐
│            CampaignChatHeader                     │
│  [Campaign Name] [Agent Avatars] [View Toggle]    │
├──────────────────────┬───────────────────────────┤
│                      │     Chrome-style Tabs      │
│   ChatInterface      │  [Overview][ICP][Leads]... │
│   (Resizable Panel)  ├───────────────────────────┤
│                      │                            │
│   - Message List     │   Active Tab Content       │
│   - Agent Status     │   (dynamic component)      │
│   - Input Area       │                            │
│                      │                            │
│   40% width default  │   Remaining width          │
│   (300px – 50% max)  │                            │
└──────────────────────┴───────────────────────────┘
```

### Campaign Chat Header
- Campaign name display
- Last message timestamp
- **Agent avatar row:** Colored circles showing agents used in conversation (initials inside)
- Search button → opens Search tab
- **View toggle:** Overview mode vs Campaign Dashboard mode

### Left Panel — Chat Interface (`ResizablePanel`)
- Default width: 40% of viewport
- Min: 300px, Max: 50% viewport
- Draggable resize handle between panels
- Contains `<ChatInterface>` component:
  - Scrollable message list with agent-typed messages
  - Processing state indicator (active agent name + status)
  - Tool execution logs
  - Example prompts for empty chat state
  - Message input area with send functionality
  - Business profile selector
  - ICP data display

### Right Panel — Tabs System

**Chrome-style Tab Bar** (`ChromeTabs` component):
- Browser-like tabs: draggable, closeable (×), reorderable
- Add (+) button creates new Search tab
- Active tab: highlighted background
- Highlighted tab: pulse animation for attention

**14+ Available Tab Types:**

| Tab Type | Label | Purpose |
|----------|-------|---------|
| `overview` | Overview | Default tab, not closeable |
| `icp` | ICP Profile | Ideal Customer Profile display/editor |
| `leads` | Leads | Lead results list |
| `leadsinputs` | Lead Config | Lead generation parameters |
| `agentchoose` | Choose Agent | Agent selection grid |
| `search` | Search | Web search results |
| `outreach` | Outreach | Outreach campaign manager |
| `campaigns` | Campaigns | Campaign dashboard |
| `content-studio` | Content Studio | Content generation hub |
| `content-email` | Email Content | Email template preview |
| `content-social` | Social Content | Social post preview |
| `content-media` | Media Content | Image/video preview |
| `content-blog` | Blog Content | Blog post preview |
| `content-adcopy` | Ad Copy | Ad copy preview |
| `content-sms` | SMS Content | SMS template preview |
| `performance-marketing` | Performance Marketing | Ad campaign management |
| `crm` | CRM | Customer records |
| `support` | Support | Support tickets |
| `proposals` | Proposals | Proposal documents |

**Tab Persistence:** Tab configurations auto-saved to server via API (`/api/chat/threads/{id}/tabs`).

### Campaign Dashboard View
- Alternative view (toggled from header)
- `<CampaignDashboardView>` component fills entire content area
- Shows campaign-level metrics and status

### Modals
- **BrandToolkitSelectorModal** — Select existing brand toolkit
- **BrandToolkitModal** — Create new brand toolkit
- **ICPSelectorModal** — Choose ICP profile
- **ToolApprovalDialog** — Approve/reject AI tool execution requests

### Real-time WebSocket Events Handled
- `chat_response` — Streaming AI messages
- `agent_status` — Agent thinking/processing indicators
- `agent_transition` — Agent switching display
- `workflow_started/progress/completed` — Workflow state
- `icp_update` — ICP profile changes
- `batch_progress` — Multi-platform operation progress
- `tool_completed/failed` — Tool execution results
- `approval_required` — Tool approval requests
- `open_tab` — Server-initiated tab creation

---

## 8. Email Outreach

**Route:** `/dashboard/outreach/email`  
**File:** `client/src/app/dashboard/(main)/outreach/email/page.tsx`

### Three-Level Drill-Down Architecture

**Level 1 — Lead Groups List:**
- List view of all leads with email conversations
- Each entry:
  - Avatar (initials or image)
  - Lead name (bold)
  - Email address
  - Company name
  - Conversation count badge
  - Unread message badge (if applicable)
- Click → drills into Level 2

**Level 2 — Conversations List:**
- Conversations for selected lead
- Each conversation: subject line, last message preview, timestamp, status
- Click → drills into Level 3

**Level 3 — Conversation Messages:**
- Full email thread view
- Message bubbles with sender info, timestamp, content
- Email compose area at bottom

### Controls
- **Search:** Filter input for leads
- **Sort:** Dropdown — recent, unread, name, messages count
- **Filters:** Status-based filtering

### Email Compose
- HTML content editor
- Attachment support
- Template selector (pre-built email templates)
- Sender picker (from connected email accounts/senders)

### Integration Check
- Shows `IntegrationRequired` component if email service not connected
- Prompts user to set up email integration first

### Animations
- `AnimatePresence` transitions between drill-down levels
- Fade + slide animations on level changes

---

## 9. Leads Page

**Route:** `/dashboard/leads`  
**File:** `client/src/app/dashboard/(main)/leads/page.tsx`

### Stats Row (8 cards)

| Stat | Color/Style |
|------|------------|
| Total Leads | Default |
| New | Green accent |
| Contacted | Blue accent |
| Engaged | Purple accent |
| Qualified | Amber accent |
| Converted | Emerald accent |
| High Quality | Gold accent |
| Avg Score | Default |

### Data Table

**Columns:**
- Checkbox (for bulk selection)
- Name
- Company
- Role/Title
- Email
- Phone
- LinkedIn URL
- Score (numeric)
- Source (badge)
- Status (colored badge)
- Fit Score
- Relevance Score
- Actions (dropdown)

**Table Features:**
- Pagination controls (page size, prev/next)
- Column sorting (click header to sort)
- Loading state: `LeadTableSkeleton` component

### Controls Bar
- **Search:** Real-time filter by name/email/company
- **Status Filter:** Dropdown (new, contacted, engaged, qualified, converted)
- **Source Filter:** Dropdown (LinkedIn, Google Maps, Manual, etc.)
- **Score Range:** Min/max score filter
- **Time Filter:** Preset ranges (last 30 days, etc.)

### Bulk Actions
- Multi-select via checkboxes
- Bulk outreach assignment
- Selection count display

### Row Actions (per-lead dropdown menu)
- **View** — Open lead details
- **Edit** — Edit lead information
- **Delete** — Remove lead (confirmation dialog)
- **Score** — Re-score lead
- **Enrich** — Run enrichment (Apify, ZeroBounce)
- **Validate Email** — Email verification check

### Export
- CSV export button for filtered results

---

## 10. Content Calendar

**Route:** `/dashboard/content-calendar`  
**File:** `client/src/app/dashboard/(main)/content-calendar/page.tsx`

### Calendar View
- **Month navigation:** ChevronLeft / ChevronRight buttons + current month/year display
- Calendar icon in header

### Calendar Grid
- Standard monthly calendar grid (7 columns × 5-6 rows)
- Each day cell can contain multiple content items

### Content Item Cards

**Platform Icons:**
- Instagram, Facebook, LinkedIn, Twitter (Lucide icons)

**Type-Based Color Coding:**

| Content Type | Light BG | Dark BG | Border | Badge |
|-------------|---------|--------|--------|-------|
| Reel | `#E0F2FE` (light blue) | `#3B4F7A` | `border-l-4 border-blue-400` | `bg-blue-500 text-white` |
| Carousel | `#F3E8FF` (light purple) | `#6B4C8A` | `border-l-4 border-purple-400` | `bg-purple-500 text-white` |
| Post | `#FFE4E6` (light rose) | `#7B3F55` | `border-l-4 border-rose-400` | `bg-rose-500 text-white` |
| Story | Separate scheme | — | Colored border-left | Colored badge |
| Ad | Separate scheme | — | Colored border-left | Colored badge |

**Status Badges:** draft, scheduled, published, failed — each with appropriate colors

### Interactions
- Click content item → Sheet (slide-over panel) with full details
- Edit button → Opens editor
- Delete → `ConfirmDialog` confirmation
- More options: `DropdownMenu` with MoreVertical trigger

### Sheet Detail View
- `SheetContent` from shadcn/ui
- `SheetHeader` / `SheetTitle` / `SheetDescription`
- Full content preview
- Platform and scheduling info
- Edit/delete actions

### Loading State
- `ContentCalendarSkeleton` component

---

## 11. Settings Page

**Route:** `/dashboard/settings`  
**File:** `client/src/app/dashboard/(main)/settings/page.tsx`

### Tab Navigation
- URL-synced via `?tab=` query parameter
- 3 tabs displayed as horizontal button group:

| Tab | Icon | Key |
|-----|------|-----|
| Profile | User | `profile` |
| Security | Shield | `security` |
| Notifications | Bell | `notifications` |

### Profile Tab
- **Fields:**
  - Full name (text input)
  - Email (text input, possibly disabled)
  - Avatar (file upload or URL)
  - Bio (textarea)
  - Phone number (text input)
  - Timezone (select dropdown)
- **Action:** Save button (primary)

### Security Tab
- **Fields:**
  - Current password (with show/hide toggle icon)
  - New password (with show/hide toggle icon)
  - Confirm new password (with show/hide toggle icon)
- **Validation:** Password strength indicators
- **Action:** Update password button

### Notifications Tab
- **Toggle switches** (on/off):
  - Email notifications
  - Lead alerts
  - Campaign updates
  - Weekly reports
- Each toggle: Label text + shadcn Switch component

### Animations
- Framer Motion `staggerChildren` on tab content entrance
- Smooth fade transitions between tabs

---

## 12. Admin Dashboard Home

**Route:** `/admin/dashboard/home`  
**File:** `client/src/app/admin/dashboard/home/page.tsx`  
**Auth:** `useAdminAuth()` with `admin_token`

### Page Header
- Title: `"Dashboard"` — `text-3xl font-bold tracking-tight`
- Subtitle: `"Overview of your admin panel"` — muted foreground

### Stats Cards (4-column grid, responsive)

| Card | Gradient | Icon |
|------|----------|------|
| Total Users | `from-purple-500/10 to-purple-700/10` | Users (white on `from-purple-500 to-purple-700`) |
| Total Admins | `from-violet-500/10 to-violet-700/10` | Shield (white on `from-violet-500 to-violet-700`) |
| System Health | `from-emerald-500/10 to-emerald-700/10` | Activity (white on `from-emerald-500 to-emerald-700`) |
| Active Leads | `from-indigo-500/10 to-indigo-700/10` | Target (white on `from-indigo-500 to-indigo-700`) |

Each card: Gradient background (`bg-gradient-to-br`), no border (`border-0`), icon in gradient-colored rounded pill.

### Quick Actions (4-column grid)

| Action | Icon | Link | Description |
|--------|------|------|-------------|
| Manage Users | Users | `/admin/dashboard/users` | View and manage all users |
| Create Admin | Plus | `/admin/dashboard/admins/new` | Add a new admin user |
| View Leads | Target | `/admin/dashboard/master-database` | Browse master lead database |
| System Settings | Settings | `/admin/dashboard/settings` | Configure system settings |

Each card:
- Icon in `rounded-lg bg-purple-100 dark:bg-purple-900/30 text-purple-600` container
- Hover: `bg-purple-200 dark:bg-purple-900/50` transition
- Label with `ArrowUpRight` icon (opacity 0 → 100 on hover)
- Description text
- Card hover: `shadow-md` increase

### System Activity Section
- Empty/placeholder state
- BarChart3 icon (large, muted) centered
- `"Activity Feed"` heading
- Description about future system activity logs

### Loading State
- Centered `Loader2` (animate-spin) in `text-purple-600`

---

## 13. Admin Users Management

**Route:** `/admin/dashboard/users`  
**File:** `client/src/app/admin/dashboard/users/page.tsx`

### Search Bar
- Full-width text input for filtering by name or email

### Users Table

**Columns:**
| Column | Content |
|--------|---------|
| Name | User's full name |
| Email | Email address |
| Role | Badge component (role name) |
| Status | Colored badge: Green=active, Yellow=pending, Red=banned |
| Verified | Verification state indicator |
| Approved | Approval state indicator |
| Created | Date formatted |
| Actions | Action buttons |

### Status Badge Colors
- **Green:** Approved, Active, Verified
- **Yellow/Amber:** Pending verification, Pending approval
- **Red:** Rejected, Banned, Unverified

### Row Actions
- **Verify** — MailCheck icon button → sends verification
- **Approve** — ClipboardCheck icon button → approves user
- **Reject** — X icon button → rejects user
- **Delete** — Trash icon button → opens `AlertDialog` confirmation:
  - Dialog title, description, Cancel + Confirm (destructive) buttons

### Loading State
- Spinner or skeleton rows

---

## 14. Support Agent Dashboard

**Route:** `/support/dashboard`  
**File:** `client/src/app/support/dashboard/page.tsx`  
**Auth:** `useSupportAuth()` with `support_token`

### Visual Design Note
**Ultra-premium design** — Uses `rounded-[2.5rem]` cards and `text-[10px] uppercase tracking-[0.15em]` labels. More refined/luxurious than standard dashboard.

### Welcome Card
- **Background:** Gradient (primary colors)
- Content: Agent's name, team name
- **"Launch Support AI"** button — navigates to AI-powered support chat

### Stats Cards (3-card row)

| Stat | Value (example) | Visual |
|------|----------------|--------|
| Active Tickets | Dynamic count | Gradient icon background |
| Resolved | Dynamic count | Gradient icon background |
| Response Rate | 98% | Gradient icon background |

Each card:
- Large number (`text-2xl` or `text-3xl` bold)
- Label in ultra-small uppercase tracking
- Icon with gradient bg container
- Hover: `scale` effect on card

### Recent Assignments
- List of ticket cards:
  - Ticket number (e.g., #1234)
  - Status badge:
    - Blue: `open`
    - Amber: `in_progress`
    - Slate: other statuses
  - Subject/title
  - Date/timestamp

### Right Sidebar
- **Knowledge Base Card** — Quick access to support KB
- **Additional Quick Actions** — contextual action cards

---

## 15. Billing & Integrations

### Billing (`/dashboard/billing`)

**File:** `client/src/app/dashboard/(main)/billing/page.tsx`

**Header:**
- Page title
- Action buttons: "Pricing" (outline), "Analytics" (outline), "Recharge" (gradient purple primary)

**Wallet Overview** (4 stat cards):

| Card | Color | Content |
|------|-------|---------|
| Available Credits | Purple gradient | Current credit balance |
| Total Added | Green | Lifetime credits purchased |
| Total Used | Red | Lifetime credits consumed |
| Total Transactions | Default | Transaction count |

**Credit-to-INR Conversion:** Displays monetary equivalent

**Navigation Cards** (grid of action cards):

| Card | Icon Color | Destination |
|------|-----------|-------------|
| Campaign Spends | Purple | `/dashboard/billing/campaigns` |
| Provider Spends | Blue | `/dashboard/billing/providers` |
| Day-wise Spends | Orange | `/dashboard/billing/daily` |
| Recharge History | Green | `/dashboard/billing/recharges` |
| Category-wise Spends | Pink | `/dashboard/billing/categories` |

Each card: Colored icon in rounded container, title, description paragraph, right arrow indicator

### Integrations (`/dashboard/integrations`)

**File:** `client/src/app/dashboard/(main)/integrations/page.tsx`

**Grid of Integration Cards:**

| Platform | Category | Status Options |
|----------|----------|---------------|
| Instagram | social_media | Browser session + OAuth |
| Email (Resend) | communication | API key connection |
| Meta/Facebook | social_media | OAuth |
| Google Ads | marketing | OAuth |
| MSG91 (SMS) | communication | API credentials |
| WhatsApp | social_media | Business API |

**Card Structure:**
- Icon with colored background (platform-specific color)
- Platform name (bold)
- Brief description
- **Status badge:**
  - `connected` — Green badge
  - `partial` — Amber badge (some features connected)
  - `not_connected` — Gray/muted badge
  - `coming_soon` — Disabled/muted
- Feature list (what the integration provides)
- Connect/Manage button

**Animations:**
- Staggered entrance animation (Framer Motion spring)
- Cards fade + slide in with delay between each
- Status loaded from multiple API endpoints in parallel (concurrent fetching)

---

## 16. Global Design System

### Color Palette

| Token | Value | Usage |
|-------|-------|-------|
| Primary | `#7c5ce6` (Purple) | Buttons, active states, icons, gradients |
| Secondary | `#b48cf2` (Light Violet) | Chart secondary, hover states |
| Tertiary | `#f6a6c1` (Pink) | Chart tertiary, decorative accents |
| Background | `hsl(var(--background))` | Page backgrounds |
| Foreground | `hsl(var(--foreground))` | Primary text |
| Muted | `hsl(var(--muted))` | Subtle backgrounds |
| Muted Foreground | `hsl(var(--muted-foreground))` | Secondary text |
| Destructive | `hsl(var(--destructive))` | Error states, delete actions |
| Border | `hsl(var(--border))` | Card/input borders |

### Typography

| Style | Classes | Usage |
|-------|---------|-------|
| Page Title | `text-3xl font-bold tracking-tight` | Main headings |
| Section Title | `text-xl font-semibold` | Section headings |
| Card Title | `text-sm font-medium` | Stat card labels |
| Label | `text-xs font-bold uppercase tracking-widest` | Sidebar labels, section headers |
| Ultra Label | `text-[10px] uppercase tracking-[0.15em]` | Support dashboard (premium) |
| Body | `text-sm` | General content |
| Muted | `text-muted-foreground` | Subtitles, descriptions |
| Brand Accent | `font-serif italic` | "AskSales.ai" logo text, hero emphasis |

### Border Radius Scale

| Value | Usage |
|-------|-------|
| `rounded-full` | Buttons, pills, badges, avatars |
| `rounded-[2.5rem]` | Premium cards, mega-menus |
| `rounded-[35px]` | Command input bar |
| `rounded-[3rem]` | CTA card |
| `rounded-2xl` | Standard cards, inputs |
| `rounded-xl` | Icon containers, dropdowns |
| `rounded-lg` | List items, inner elements |

### Glassmorphism

| Component | Classes |
|-----------|---------|
| Header | `bg-background/60 backdrop-blur-xl` |
| Sidebar | `bg-background/80 backdrop-blur-2xl` |
| Hero elements | `bg-white/5 backdrop-blur-md` |
| CTA card | `bg-gradient-to-br backdrop-blur-lg` |

### Shadow Scale

| Level | Classes | Usage |
|-------|---------|-------|
| Ambient | `shadow-2xl shadow-black/5` | Sidebar |
| Elevated | `shadow-lg shadow-primary/30` | Active icons |
| Card | `shadow-[0_4px_20px_-2px_rgba(0,0,0,0.1)]` | Command input |
| Hover | `hover:shadow-md` | Interactive cards |
| Glow | `shadow-[0_0_8px_rgba(var(--primary),0.6)]` | Active dot indicator |

### Animation Patterns (Framer Motion v12)

| Pattern | Properties | Usage |
|---------|-----------|-------|
| Page entrance | `motion.div` + `initial/animate` + `fade+slideUp` | Form sections, page content |
| Scroll reveal | `whileInView` + `viewport={{ once: true }}` | Landing page sections |
| Stagger children | `staggerChildren: 0.1` + `variants` | Card grids, list items |
| Spring physics | `type: "spring", stiffness, damping` | Resizable panels, progress bar |
| Marquee | CSS `@keyframes` + `animation` classes | Logo marquee, suggestion pills |
| Hover lift | `translate-y-[-4px]` + `shadow` increase | Agent cards |
| Active pulse | `animate-pulse` | Mic recording, tab highlight |
| Scale press | `active:scale-95` | Buttons |
| Rotate | `rotate-180` on state | Chevron toggles |
| Slide in | `slide-in-from-top-2` | Expanded sidebar children |

### Component Library (shadcn/ui)

47 components used, key ones:
- **Layout:** Card, CardHeader, CardContent, CardTitle, CardDescription
- **Forms:** Input, Button, Select, Checkbox, Switch, Textarea, Form, FormField, FormItem, FormLabel, FormControl
- **Feedback:** Badge, Toast, Skeleton, Loader2 (spinner)
- **Overlay:** Dialog, AlertDialog, Sheet, DropdownMenu, Tooltip
- **Data:** Table, Tabs, Accordion, Separator

### Icon Library
- **Lucide React** (exclusively)
- Commonly used: Users, Target, Activity, Send, MessageSquare, Settings, ChevronDown, Plus, Search, Loader2, ArrowUpRight, Eye, Clock, TrendingUp, BarChart3, Mic, FileText, Megaphone, Shield, Bell, etc.

### Chart Library
- **Recharts v3** with `ResponsiveContainer`
- Chart types: AreaChart, BarChart, LineChart, PieChart
- Color scheme consistently uses primary/secondary/tertiary palette
- Gradient fills under area curves
- Custom tooltips and legends

### Dark Mode
- Full support via `next-themes` ThemeProvider
- All components use `dark:` Tailwind variants
- CSS variables for semantic colors
- Theme toggle in header (Sun ↔ Moon)

### Responsive Breakpoints
- Mobile-first approach
- `sm:` (640px), `md:` (768px), `lg:` (1024px), `xl:` (1280px)
- Sidebar collapse on mobile with overlay
- Grid columns: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`
- Left panel hidden on mobile (login/register split-screen)

---

*Report generated from source code analysis. All visual descriptions derived from actual component implementations.*
