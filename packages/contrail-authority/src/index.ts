/** @atmo-dev/contrail-authority — default space-authority implementation.
 *
 *  Owns the authority-side adapter (member list, invites, app policy, space
 *  lifecycle) and DDL. Route registration currently lives in
 *  @atmo-dev/contrail and will move here in a subsequent extraction pass. */

export {
  HostedAuthorityAdapter,
  parseJson,
  toNum,
  mapSpaceRow,
  mapMemberRow,
  mapInviteRow,
} from "./adapter";

export {
  buildAuthoritySchema,
  applyAuthoritySchema,
} from "./schema";
