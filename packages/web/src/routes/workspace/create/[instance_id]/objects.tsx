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

/* eslint-disable unicorn/no-null -- Kobalte requires null for an empty selection. */

import { Select } from "@kobalte/core/select";
import { TextField } from "@kobalte/core/text-field";
import { Title } from "@solidjs/meta";
import {
  type RouteDefinition,
  type RouteSectionProps,
  query,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show, createSignal } from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import * as v from "valibot";

import type { CreateObjectMutation } from "./__generated__/CreateObjectMutation.graphql.ts";
import type { InstanceActorListQuery } from "./__generated__/InstanceActorListQuery.graphql.ts";

const instanceActorListQuery = graphql`
  query InstanceActorListQuery($instanceId: ID!) {
    instance: node(id: $instanceId) {
      ... on Instance {
        id
        host
        url
        actors(first: 100) {
          totalCount
          edges {
            node {
              handle
              id
            }
          }
        }
      }
    }
  }
`;

const createObjectMutation = graphql`
  mutation CreateObjectMutation(
    $actor: ID!
    $contentHtml: String!
    $type: ObjectType!
    $addressing: AddressingInput!
  ) {
    createObject(
      actor: $actor
      contentHtml: $contentHtml
      type: $type
      addressing: $addressing
    ) {
      resultType: __typename
      ... on Object {
        id
      }
      ... on CreateObjectError {
        message
      }
    }
  }
`;

const recipientSchema = v.pipe(v.string(), v.url());
const recipientsSchema = v.optional(v.array(recipientSchema), []);
const createObjectSchema = v.object({
  actor: v.pipe(v.string("Select an actor."), v.nonEmpty("Select an actor.")),
  contentHtml: v.pipe(
    v.string(),
    v.check((content) => content.trim() !== "", "Enter content."),
  ),
  type: v.picklist(["Note", "Article"]),
  addressing: v.strictObject({
    to: recipientsSchema,
    cc: recipientsSchema,
    bto: recipientsSchema,
    bcc: recipientsSchema,
    audience: recipientsSchema,
  }),
});

const loadInstanceActorListQuery = query(
  (instanceId: string) =>
    loadQuery<InstanceActorListQuery>(
      useRelayEnvironment()(),
      instanceActorListQuery,
      { instanceId },
    ),
  "InstanceActorListQuery",
);

export const route = {
  preload({ params }) {
    if (params.instance_id === undefined) {
      throw new Error("Missing instance_id route parameter.");
    }
    return loadInstanceActorListQuery(params.instance_id);
  },
} satisfies RouteDefinition;

type RouteData = ReturnType<typeof loadInstanceActorListQuery>;
interface ActorOption {
  readonly id: string;
  readonly handle: string;
}

export default function CreateObjectsPage(props: RouteSectionProps<RouteData>) {
  const data = createPreloadedQuery<InstanceActorListQuery>(
    instanceActorListQuery,
    () => props.data,
  );

  const actors = () => data()?.instance?.actors?.edges;

  const [currentActor, setCurrentActor] = createSignal<ActorOption | null>(
    null,
  );

  const [commitCreateObject, isCreating] =
    createMutation<CreateObjectMutation>(createObjectMutation);
  const [errorMessage, setErrorMessage] = createSignal<string>();
  const [successMessage, setSuccessMessage] = createSignal<string>();

  const submit = (form: HTMLFormElement) => {
    if (isCreating()) return;
    setErrorMessage(undefined);
    setSuccessMessage(undefined);
    const formData = new FormData(form);
    const addressingText = formData.get("addressing");
    let addressing: unknown;
    try {
      addressing = JSON.parse(
        typeof addressingText === "string" ? addressingText : "{}",
      );
    } catch {
      setErrorMessage("Addressing must be valid JSON.");
      return;
    }
    const input = v.safeParse(createObjectSchema, {
      actor: (currentActor() ?? actors()?.[0]?.node)?.id,
      contentHtml: formData.get("content"),
      type: formData.get("type"),
      addressing,
    });
    if (!input.success) {
      setErrorMessage(input.issues.map((issue) => issue.message).join("\n"));
      return;
    }
    commitCreateObject({
      variables: input.output,
      onCompleted(response, errors) {
        if (errors != null && errors.length > 0) {
          setErrorMessage(errors.map((error) => error.message).join("\n"));
          return;
        }
        const result = response.createObject;
        if (result.resultType === "Object") {
          form.reset();
          setSuccessMessage("Object created successfully.");
        } else {
          setErrorMessage(
            result.resultType === "CreateObjectError"
              ? result.message
              : "Unable to create the object.",
          );
        }
      },
      onError: (error) => setErrorMessage(error.message),
    });
  };

  return (
    <Show when={actors()} fallback={<main>Instance not found.</main>}>
      {(actorList) => (
        <main>
          <Title>Create Object</Title>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit(event.currentTarget);
            }}
            onReset={() => {
              setCurrentActor(null);
              setErrorMessage(undefined);
              setSuccessMessage(undefined);
            }}
          >
            <fieldset disabled={isCreating()}>
              <Select<ActorOption>
                disabled={isCreating()}
                value={currentActor() ?? actorList()[0]?.node ?? null}
                onChange={setCurrentActor}
                optionValue="id"
                optionTextValue="handle"
                placeholder="Select Handle"
                options={actorList().map((actor) => actor.node)}
                itemComponent={(itemProps) => (
                  <Select.Item item={itemProps.item}>
                    <Select.ItemLabel>
                      {itemProps.item.rawValue.handle}
                    </Select.ItemLabel>
                    <Select.ItemIndicator>V</Select.ItemIndicator>
                  </Select.Item>
                )}
              >
                <Select.Label>Actor</Select.Label>
                <Select.Trigger type="button">
                  <Select.Value<ActorOption>>
                    {(state) => state.selectedOption().handle}
                  </Select.Value>
                  <Select.Icon>▾</Select.Icon>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Content>
                    <Select.Listbox />
                  </Select.Content>
                </Select.Portal>
              </Select>

              <label>
                Type
                <select name="type">
                  <option value="Note" selected>
                    Note
                  </option>
                  <option value="Article">Article</option>
                </select>
              </label>

              <TextField name="content" required>
                <TextField.Label>Content</TextField.Label>
                <TextField.TextArea />
              </TextField>
              <TextField name="addressing" defaultValue="{}">
                <TextField.Label>Addressing</TextField.Label>
                <TextField.Input />
              </TextField>
              <div>
                <button type="reset">Reset</button>
                <button
                  type="submit"
                  disabled={isCreating() || (actors()?.length ?? 0) === 0}
                >
                  {isCreating() ? "Creating…" : "Submit"}
                </button>
              </div>
            </fieldset>
            <Show when={errorMessage()}>
              {(message) => <p role="alert">{message()}</p>}
            </Show>
            <Show when={successMessage()}>
              {(message) => <output>{message()}</output>}
            </Show>
          </form>
        </main>
      )}
    </Show>
  );
}
