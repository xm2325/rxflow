import {
  CircuitBreakerPaDraftGenerator,
  DeterministicPaDraftGenerator,
  MetadataLogAiTraceSink,
  TimeoutPaDraftGenerator,
  TracingPaDraftGenerator,
  type AiTraceSink,
  type PaDraftGenerator
} from "./ai.js";
import type { RuntimeConfig } from "./config.js";

export interface RuntimePaGenerator {
  generator: PaDraftGenerator;
  breaker: CircuitBreakerPaDraftGenerator;
}

export function wrapRuntimePaDraftGenerator(
  inner: PaDraftGenerator,
  config: Pick<RuntimeConfig, "paTimeoutMs" | "paCircuitFailureThreshold" | "paCircuitResetMs">,
  traceSink: AiTraceSink = new MetadataLogAiTraceSink(),
  provider = "deterministic-local"
): RuntimePaGenerator {
  const bounded = new TimeoutPaDraftGenerator(inner, config.paTimeoutMs);
  const breaker = new CircuitBreakerPaDraftGenerator(
    bounded,
    config.paCircuitFailureThreshold,
    config.paCircuitResetMs
  );
  return {
    breaker,
    generator: new TracingPaDraftGenerator(breaker, traceSink, provider)
  };
}

export function createRuntimePaDraftGenerator(config: RuntimeConfig): RuntimePaGenerator {
  return wrapRuntimePaDraftGenerator(new DeterministicPaDraftGenerator(), config);
}
