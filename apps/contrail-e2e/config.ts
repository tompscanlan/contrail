import type { ContrailConfig } from "@atmo-dev/contrail";

// Namespace matches atmo.rsvp so the same atmo-events frontend can point at
// this devnet-backed Contrail without patching its hardcoded namespace.
// See https://github.com/flo-bit/atmo-events/issues/26 for making this
// configurable upstream.
export const config: ContrailConfig = {
  namespace: "rsvp.atmo",
  jetstreams: [
    process.env.JETSTREAM_URL ?? "ws://localhost:6008/subscribe",
  ],
  collections: {
    event: {
      collection: "community.lexicon.calendar.event",
      queryable: {
        mode: {},
        name: {},
        status: {},
        startsAt: { type: "range" },
        endsAt: { type: "range" },
        createdAt: { type: "range" },
      },
      searchable: ["name", "description"],
      relations: {
        rsvps: {
          collection: "rsvp",
          groupBy: "status",
          count: true,
          groups: {
            interested: "community.lexicon.calendar.rsvp#interested",
            going: "community.lexicon.calendar.rsvp#going",
            notgoing: "community.lexicon.calendar.rsvp#notgoing",
          },
        },
      },
    },
    rsvp: {
      collection: "community.lexicon.calendar.rsvp",
      queryable: {
        status: {},
        "subject.uri": {},
      },
      references: {
        event: {
          collection: "event",
          field: "subject.uri",
        },
      },
    },
  },
};
