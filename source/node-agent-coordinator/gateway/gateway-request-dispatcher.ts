import { COORDINATOR_UNKNOWN_METHOD, type CoordinatorReplyOutcome } from "../../shared/rpc/coordinator-port.js";
import { isCoordinatorMethod, validateCoordinatorReply } from "../../shared/rpc/coordinator.js";
import { SandGatewayCommandError } from "./gateway-errors.js";
import { SandGatewayUnreachableError } from "./gateway-reachability.js";

export const GATEWAY_COMMAND_FAILED = "gateway-command-failed";
export const GATEWAY_UNREACHABLE = "gateway-unreachable";
export const GATEWAY_TRANSPORT_FAILED = "gateway-transport-failed";

export function failureFor(error: unknown, method?: string): { code: string; message: string; transportKind?: string } {
  // Имя команды — часть отказа. Без него в интерфейсе остаётся «gateway-command-failed»
  // и текст ошибки, а какая именно команда не сработала, приходится искать по всему коду.
  const named = (failure: { code: string; message: string; transportKind?: string }) =>
    method == null || method.length === 0 || failure.message.includes(method)
      ? failure
      : { ...failure, message: `${method}: ${failure.message}` };
  if (error instanceof SandGatewayCommandError) return named({ code: GATEWAY_COMMAND_FAILED, message: error.message });
  if (error instanceof SandGatewayUnreachableError) return named({ code: GATEWAY_UNREACHABLE, message: error.message, transportKind: error.kind });
  return named({ code: GATEWAY_TRANSPORT_FAILED, message: error instanceof Error ? error.message : String(error) });
}

export interface GatewayCommandClient {
  dispatchCommand(method: string, args: unknown, options: { signal?: AbortSignal }): Promise<unknown>;
}

export function createGatewayRequestDispatch(client: GatewayCommandClient, serves: (method: string) => boolean = isCoordinatorMethod) {
  return async (method: string, args: unknown, signal?: AbortSignal): Promise<CoordinatorReplyOutcome> => {
    if (!serves(method)) return { status: "failed", failure: { code: COORDINATOR_UNKNOWN_METHOD, message: `no coordinator method named ${method}` } };
    try {
      const value = validateCoordinatorReply(method, await client.dispatchCommand(method, args, { ...(signal === undefined ? {} : { signal }) }));
      return { status: "ok", value };
    } catch (error) {
      return { status: "failed", failure: failureFor(error, method) };
    }
  };
}
