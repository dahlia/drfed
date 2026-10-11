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

import { getCookie } from "@solidjs/start/http";
import {
  Environment,
  type FetchFunction,
  type GraphQLResponse,
  Network,
  RecordSource,
  Store,
} from "relay-runtime";
import { getRequestEvent } from "solid-js/web";

const SESSION_COOKIE = "session";

// oxlint-disable no-async-await
const fetchGraphQL = async (
  query: string,
  variables: Parameters<FetchFunction>[1],
): Promise<GraphQLResponse> => {
  "use server";

  const request = getRequestEvent()?.request;
  if (request === undefined) throw new Error("Missing web request context.");
  const { queryGraphql } = await import("@drfed/web/bridge");
  const result = await queryGraphql(
    query,
    variables,
    getCookie(SESSION_COOKIE),
    request.signal,
  );

  // oxlint-disable return-await no-unsafe-return
  return result;
};

const fetchFn: FetchFunction = async (params, variables) => {
  if (params.text == undefined || params.text == "") {
    throw new Error(`Relay operation ${params.name} has no query text.`);
  }
  const graphQLResponse = await fetchGraphQL(params.text, variables);
  return graphQLResponse;
};

export function createRelayEnvironment() {
  return new Environment({
    network: Network.create(fetchFn),
    store: new Store(new RecordSource()),
  });
}
