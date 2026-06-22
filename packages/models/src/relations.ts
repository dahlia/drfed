// DrFed: A web-based platform for developing and debugging ActivityPub apps
// Copyright (C) 2026 DrFed team
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
import { defineRelations } from "drizzle-orm";

import * as schema from "./schema.ts";

export const relations = defineRelations(schema, (r) => ({
  accounts: {
    instances: r.many.instances({
      from: r.accounts.id.through(r.instanceMembers.accountId),
      to: r.instances.id.through(r.instanceMembers.instanceId),
    }),
  },
  instanceMembers: {
    account: r.one.accounts({
      from: r.instanceMembers.accountId,
      to: r.accounts.id,
    }),
    instance: r.one.instances({
      from: r.instanceMembers.instanceId,
      to: r.instances.id,
    }),
  },
  instances: {
    members: r.many.accounts({
      from: r.instances.id.through(r.instanceMembers.instanceId),
      to: r.accounts.id.through(r.instanceMembers.accountId),
    }),
  },
}));

export default relations;
