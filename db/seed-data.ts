import type { ProfileInput } from "./profile-input";

/**
 * Hand-written by Jack from public knowledge: real, named, Bay-Area-headquartered startups,
 * never scraped and never invented. `db/seed-fallback.ts` is the only thing that reads this
 * list, and it stamps `provenance: jack` on every field of every row it takes from here,
 * because Jack typed it rather than a page or a pipeline. See docs/adr/0002 for why this
 * fallback exists at all.
 *
 * Ordered roughly by how recognisable the company is, so a partial backfill — the table
 * already holds a few Profiles from #4 and only needs some more — tops up with the most
 * useful cards first. Long enough on its own to bring an empty table up to
 * `MINIMUM_PROFILE_COUNT` in `db/seed-fallback.ts`.
 */
export const SEED_PROFILES: readonly ProfileInput[] = [
  {
    name: "Stripe",
    description:
      "Payment processing and financial infrastructure APIs for the internet.",
    sector: "Payments Infrastructure",
    stage: "growth",
    website: "https://stripe.com",
  },
  {
    name: "Airbnb",
    description:
      "Marketplace for booking short-term stays and experiences hosted by locals.",
    sector: "Travel & Hospitality",
    stage: "growth",
    website: "https://airbnb.com",
  },
  {
    name: "DoorDash",
    description:
      "Logistics platform for on-demand delivery from restaurants and retailers.",
    sector: "Delivery & Logistics",
    stage: "growth",
    website: "https://doordash.com",
  },
  {
    name: "Instacart",
    description:
      "Marketplace connecting shoppers with same-day grocery delivery.",
    sector: "Grocery & Delivery",
    stage: "growth",
    website: "https://instacart.com",
  },
  {
    name: "Databricks",
    description:
      "Unified data, analytics and AI platform built around Apache Spark.",
    sector: "Data & AI Infrastructure",
    stage: "growth",
    website: "https://databricks.com",
  },
  {
    name: "Figma",
    description:
      "Browser-based collaborative interface design and prototyping tool.",
    sector: "Design Software",
    stage: "growth",
    website: "https://figma.com",
  },
  {
    name: "Notion Labs",
    description:
      "All-in-one workspace for notes, docs, wikis and project tracking.",
    sector: "Productivity Software",
    stage: "growth",
    website: "https://notion.so",
  },
  {
    name: "Brex",
    description:
      "Corporate cards and spend management built for startups and enterprises.",
    sector: "Fintech",
    stage: "growth",
    website: "https://brex.com",
  },
  {
    name: "Rippling",
    description: "Unified platform for payroll, HR, IT and device management.",
    sector: "HR & IT Platform",
    stage: "growth",
    website: "https://rippling.com",
  },
  {
    name: "Gusto",
    description:
      "Payroll, benefits and HR software built for small businesses.",
    sector: "Payroll & Benefits",
    stage: "growth",
    website: "https://gusto.com",
  },
  {
    name: "Plaid",
    description:
      "API for connecting bank accounts into financial applications.",
    sector: "Financial Infrastructure",
    stage: "series-b-plus",
    website: "https://plaid.com",
  },
  {
    name: "Robinhood Markets",
    description:
      "Commission-free mobile brokerage for stocks, options and crypto.",
    sector: "Consumer Investing",
    stage: "growth",
    website: "https://robinhood.com",
  },
  {
    name: "Coinbase",
    description: "Platform for buying, selling and storing cryptocurrency.",
    sector: "Crypto Exchange",
    stage: "growth",
    website: "https://coinbase.com",
  },
  {
    name: "Asana",
    description:
      "Work management software for tracking team projects and tasks.",
    sector: "Work Management",
    stage: "growth",
    website: "https://asana.com",
  },
  {
    name: "Cloudflare",
    description:
      "Content delivery network, security and edge compute for websites.",
    sector: "Cloud & Security",
    stage: "growth",
    website: "https://cloudflare.com",
  },
  {
    name: "Twilio",
    description:
      "Programmable APIs for SMS, voice and other customer communications.",
    sector: "Communications API",
    stage: "growth",
    website: "https://twilio.com",
  },
  {
    name: "Lyft",
    description: "Ride-hailing marketplace connecting drivers and riders.",
    sector: "Rideshare",
    stage: "growth",
    website: "https://lyft.com",
  },
  {
    name: "Pinterest",
    description: "Visual discovery platform for finding and saving ideas.",
    sector: "Social Media",
    stage: "growth",
    website: "https://pinterest.com",
  },
  {
    name: "Reddit",
    description:
      "Network of topic-based communities for discussion and content sharing.",
    sector: "Social Media",
    stage: "growth",
    website: "https://reddit.com",
  },
  {
    name: "Nextdoor",
    description:
      "Social network organised around neighborhoods and local communities.",
    sector: "Local Social Network",
    stage: "growth",
    website: "https://nextdoor.com",
  },
  {
    name: "Affirm",
    description: "Point-of-sale installment loans for consumer purchases.",
    sector: "Consumer Lending",
    stage: "growth",
    website: "https://affirm.com",
  },
  {
    name: "Chime",
    description:
      "Mobile-first digital banking with no-fee checking and savings accounts.",
    sector: "Consumer Banking",
    stage: "growth",
    website: "https://chime.com",
  },
  {
    name: "Anthropic",
    description:
      "AI safety research lab and developer of the Claude family of models.",
    sector: "AI Research",
    stage: "growth",
    website: "https://anthropic.com",
  },
  {
    name: "OpenAI",
    description: "AI research lab and developer of the ChatGPT product line.",
    sector: "AI Research",
    stage: "growth",
    website: "https://openai.com",
  },
  {
    name: "Scale AI",
    description: "Data labeling and infrastructure for training AI models.",
    sector: "AI Infrastructure",
    stage: "series-b-plus",
    website: "https://scale.com",
  },
  {
    name: "Discord",
    description:
      "Voice, video and text chat platform built around communities.",
    sector: "Chat & Community",
    stage: "growth",
    website: "https://discord.com",
  },
  {
    name: "Samsara",
    description:
      "Connected sensor data platform for vehicle fleets and physical operations.",
    sector: "IoT & Fleet Management",
    stage: "growth",
    website: "https://samsara.com",
  },
  {
    name: "Faire",
    description:
      "Wholesale marketplace connecting independent retailers with brands.",
    sector: "Wholesale Marketplace",
    stage: "series-b-plus",
    website: "https://faire.com",
  },
  {
    name: "Ripple",
    description:
      "Blockchain-based payments network for cross-border settlement.",
    sector: "Crypto Payments",
    stage: "series-b-plus",
    website: "https://ripple.com",
  },
  {
    name: "Airtable",
    description:
      "No-code database and spreadsheet hybrid for building custom apps.",
    sector: "No-Code Software",
    stage: "series-b-plus",
    website: "https://airtable.com",
  },
  {
    name: "Benchling",
    description:
      "R&D software platform for biotechnology and life sciences teams.",
    sector: "Life Sciences Software",
    stage: "series-b-plus",
  },
  {
    name: "Glean",
    description:
      "AI-powered enterprise search across a company's internal tools and docs.",
    sector: "Enterprise Search",
    stage: "series-b-plus",
  },
  {
    name: "Perplexity",
    description:
      "AI-powered answer engine that cites sources for its search results.",
    sector: "AI Search",
    stage: "series-b-plus",
    website: "https://perplexity.ai",
  },
  {
    name: "Sourcegraph",
    description:
      "Code search and AI-assisted navigation across large codebases.",
    sector: "Developer Tools",
    stage: "series-b-plus",
    website: "https://sourcegraph.com",
  },
  {
    name: "Retool",
    description: "Low-code builder for internal business applications.",
    sector: "Low-Code Software",
    stage: "series-b-plus",
    website: "https://retool.com",
  },
];
