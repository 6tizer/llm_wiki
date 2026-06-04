import type { QueryControl } from "./core.js";
import type { AgentMessage, RewindFilesRequest } from "./types.js";

interface RewindBridgeArgs {
	request: RewindFilesRequest;
	activeSdkQueries: Map<string, QueryControl>;
	send: (msg: AgentMessage) => void;
	onSettled?: () => void;
}

type RewindUnavailableReason =
	| "inactive_stream"
	| "unsupported"
	| "missing_message_id"
	| "transport_closed";

function sendUnavailable(
	request: RewindFilesRequest,
	send: (msg: AgentMessage) => void,
	error: string,
	unavailableReason: RewindUnavailableReason,
): void {
	send({
		streamId: request.streamId,
		type: "rewind_files",
		data: {
			messageId: request.messageId,
			ok: false,
			error,
			unavailableReason,
		},
	});
}

function isTransportClosedError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /not ready for writing|terminated process|transport is closed|ended stdin/i.test(message);
}

export function handleRewindFilesRequest({
	request,
	activeSdkQueries,
	send,
	onSettled,
}: RewindBridgeArgs): void {
	const activeQuery = activeSdkQueries.get(request.streamId);
	if (!activeQuery) {
		sendUnavailable(
			request,
			send,
			"Agent stream is no longer active",
			"inactive_stream",
		);
		onSettled?.();
		return;
	}
	if (!activeQuery.rewindFiles) {
		sendUnavailable(
			request,
			send,
			"Active Agent query does not support file rewind",
			"unsupported",
		);
		onSettled?.();
		return;
	}
	if (!request.messageId) {
		sendUnavailable(
			request,
			send,
			"Missing SDK user message id",
			"missing_message_id",
		);
		onSettled?.();
		return;
	}
	activeQuery.rewindFiles(request.messageId)
		.then((result) => {
			send({
				streamId: request.streamId,
				type: "rewind_files",
				data: {
					messageId: request.messageId,
					ok: result.canRewind,
					result,
					error: result.error,
				},
			});
		})
		.catch((err) => {
			if (isTransportClosedError(err)) {
				activeSdkQueries.delete(request.streamId);
				sendUnavailable(
					request,
					send,
					"Agent stream is no longer available for file rewind",
					"transport_closed",
				);
				return;
			}
			send({
				streamId: request.streamId,
				type: "rewind_files",
				data: {
					messageId: request.messageId,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				},
			});
		})
		.finally(() => {
			onSettled?.();
		});
}
