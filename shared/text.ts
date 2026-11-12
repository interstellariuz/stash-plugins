/**
 * UI strings through Stash's own catalogue.
 *
 * Each plugin keeps a table of English defaults under ids namespaced by its
 * plugin id, which no Stash message uses. An id the server's catalogue has
 * wins, so a custom-locales.json can translate or reword any of them. The
 * catalogue is checked through intl.messages rather than by handing
 * formatMessage a defaultMessage: for an unknown id formatMessage renders the
 * id itself and logs a missing-translation error every render. A shape
 * without `messages` (an older or newer react-intl) only means nothing can
 * override a default.
 */

import { React, useIntl } from "./stash";
import { fill } from "./util";

export type Values = Record<string, unknown>;

export function makeText<T extends Record<string, string>>(table: T) {
  type Id = keyof T & string;
  type Fmt = (id: Id, values?: Values) => string;

  function useText(): Fmt {
    const intl = useIntl();
    return React.useCallback<Fmt>(
      (id, values) => (intl.messages?.[id] ? intl.formatMessage({ id }, values) : fill(table[id], values)),
      [intl]
    );
  }

  /** One string as an element, for callers that are not components */
  const Text: React.FC<{ id: Id; values?: Values }> = ({ id, values }) => {
    const text = useText();
    return React.createElement(React.Fragment, null, text(id, values));
  };

  return { useText, Text };
}

/** Stash's own message, when a label has one */
export function useStashText() {
  const intl = useIntl();
  return React.useCallback(
    (id: string, fallback: string) => (intl.messages?.[id] ? intl.formatMessage({ id }) : fallback),
    [intl]
  );
}

export type StashText = ReturnType<typeof useStashText>;
