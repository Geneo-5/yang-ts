/** §208 — React context exposing the engine's compiled schema as plain, serializable state. */
import {
  createContext, createElement, useContext, useEffect, useState,
  type ReactElement, type ReactNode,
} from "react";
import type { CompiledYangSchema } from "../yang/compiler.js";

/**
 * Plain serializable state: the compiled schema renders fine, errors become
 * text (never Error objects) so `JSON.stringify`/debuggers show honest values.
 */
export type YangSchemaState =
  | { status: "loading" }
  | { status: "ready"; schema: CompiledYangSchema }
  | { status: "error"; error: string };

export interface YangProviderProps {
  /**
   * An already-compiled schema: the provider exposes it from the first render
   * (server render and hydration match — §209). Takes precedence over `compile`.
   */
  schema?: CompiledYangSchema | undefined;
  /**
   * Compilation to run in an effect on mount (§209): the first render shows a
   * loading state and the result hydrates without mismatch. Re-runs when the
   * factory identity changes; results of stale runs are dropped.
   */
  compile?: (() => Promise<CompiledYangSchema>) | undefined;
  children?: ReactNode | undefined;
}

const YangSchemaContext = createContext<YangSchemaState | undefined>(undefined);

/** Exposes a compiled schema; initialization happens in an effect, never in render. */
export function YangProvider(props: YangProviderProps): ReactElement {
  const [state, setState] = useState<YangSchemaState>(() =>
    props.schema
      ? { status: "ready", schema: props.schema }
      : { status: "loading" });
  useEffect(() => {
    if (props.schema) {
      setState(previous =>
        previous.status === "ready" && previous.schema === props.schema
          ? previous
          : { status: "ready", schema: props.schema! });
      return;
    }
    if (!props.compile) return; // no source: stay loading (the caller decides)
    let cancelled = false;
    props.compile().then(
      schema => { if (!cancelled) setState(previous => previous.status === "ready" && previous.schema === schema ? previous : { status: "ready", schema }); },
      error => { if (!cancelled) setState({ status: "error", error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { cancelled = true; };
  }, [props.schema, props.compile]);
  return createElement(YangSchemaContext.Provider, { value: state }, props.children ?? null);
}

/** Current schema state; using hooks outside a provider reports an explicit error state. */
export function useYangSchema(): YangSchemaState {
  const value = useContext(YangSchemaContext);
  return value ?? { status: "error", error: "useYangSchema requires a <YangProvider> ancestor" };
}
