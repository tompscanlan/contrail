import type { ContrailConfig } from "@atmo-dev/contrail";

export const config: ContrailConfig = {
  namespace: "com.example",
  collections: {
    event: {
      collection: "community.lexicon.calendar.event", // NSID to index
      queryable: { startsAt: { type: "range" } },     // ?startsAtMin=...
      searchable: ["name", "description"],            // ?search=...
    },
  },
};
