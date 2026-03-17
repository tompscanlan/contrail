import type { ContrailConfig } from "./core/types";

export const config: ContrailConfig = {
  collections: {
    "community.lexicon.calendar.event": {
      relations: {
        rsvps: {
          collection: "community.lexicon.calendar.rsvp",
          groupBy: "status",
        },
      },
    },
    "community.lexicon.calendar.rsvp": {},
    "app.blento.card": {}
  },
  profiles: ["app.bsky.actor.profile", "app.blento.profile"],
};
