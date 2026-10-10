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

import SchemaBuilder, { BasePlugin, type SchemaTypes } from "@pothos/core";
import type {
  GraphQLFieldResolver,
  GraphQLIsTypeOfFn,
  GraphQLTypeResolver,
} from "graphql";

/** Track the lifetime of work that may outlive a cancelled HTTP request. */
export type OperationTracker = <T>(
  operation: () => T | Promise<T>,
) => Promise<T>;

class OperationsPlugin<Types extends SchemaTypes> extends BasePlugin<Types> {
  // Pothos requires an instance hook even when the wrapper has no plugin state.
  // oxlint-disable-next-line class-methods-use-this
  override wrapResolve(
    resolve: GraphQLFieldResolver<unknown, Types["Context"], object>,
  ): GraphQLFieldResolver<unknown, Types["Context"], object> {
    return (parent, args, context, info) => {
      const { trackOperation } = context as {
        trackOperation?: OperationTracker;
      };
      return trackOperation == null
        ? resolve(parent, args, context, info)
        : trackOperation(() => resolve(parent, args, context, info));
    };
  }
  // Pothos dispatches abstract type resolution separately from field resolution.
  // oxlint-disable-next-line class-methods-use-this
  override wrapResolveType(
    resolveType: GraphQLTypeResolver<unknown, Types["Context"]>,
  ): GraphQLTypeResolver<unknown, Types["Context"]> {
    return (parent, context, info, type) => {
      const { trackOperation } = context as {
        trackOperation?: OperationTracker;
      };
      return trackOperation == null
        ? resolveType(parent, context, info, type)
        : trackOperation(() => resolveType(parent, context, info, type));
    };
  }

  // ScopeAuth performs type-level authorization through this separate hook.
  // oxlint-disable-next-line class-methods-use-this
  override wrapIsTypeOf(
    isTypeOf: GraphQLIsTypeOfFn<unknown, Types["Context"]> | undefined,
  ): GraphQLIsTypeOfFn<unknown, Types["Context"]> | undefined {
    if (isTypeOf == null) return isTypeOf;
    return (parent, context, info) => {
      const { trackOperation } = context as {
        trackOperation?: OperationTracker;
      };
      return trackOperation == null
        ? isTypeOf(parent, context, info)
        : trackOperation(() => isTypeOf(parent, context, info));
    };
  }
}

declare global {
  // Pothos registers plugin types through this namespace.
  // oxlint-disable-next-line typescript/no-namespace
  namespace PothosSchemaTypes {
    interface Plugins<Types extends SchemaTypes> {
      drfedOperations: OperationsPlugin<Types>;
    }
  }
}

SchemaBuilder.registerPlugin("drfedOperations", OperationsPlugin);

export default "drfedOperations" as const;
