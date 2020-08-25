/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { toUtf8 } from "@fluidframework/common-utils";
import { ProtocolOpHandler } from "@fluidframework/protocol-base";
import { IDocumentAttributes, ISequencedDocumentMessage, IProtocolState } from "@fluidframework/protocol-definitions";
import { IGitManager } from "@fluidframework/server-services-client";
import { ILogger } from "@fluidframework/server-services-core";
import { IDeliCheckpoint } from "../deli";

export interface ILatestSummaryState {
    term: number;
    protocolHead: number;
    scribe: string;
    messages: ISequencedDocumentMessage[];
    fromSummary: boolean;
}

export async function fetchLatestSummaryState(
    gitManager: IGitManager,
    documentId: string,
    logger: ILogger): Promise<ILatestSummaryState> {
    const existingRef = await gitManager.getRef(encodeURIComponent(documentId));
    if (!existingRef) {
        return {
            term: 1,
            protocolHead: 0,
            scribe: "",
            messages: [],
            fromSummary: false,
        };
    }

    try {
        const [attributesContent, scribeContent, deliContent, opsContent] = await Promise.all([
            gitManager.getContent(existingRef.object.sha, ".protocol/attributes"),
            gitManager.getContent(existingRef.object.sha, ".serviceProtocol/scribe"),
            gitManager.getContent(existingRef.object.sha, ".serviceProtocol/deli"),
            gitManager.getContent(existingRef.object.sha, ".logTail/logTail"),
        ]);
        const attributes =
            JSON.parse(toUtf8(attributesContent.content, attributesContent.encoding)) as IDocumentAttributes;
        const scribe = toUtf8(scribeContent.content, scribeContent.encoding);
        const deli = JSON.parse(toUtf8(deliContent.content, deliContent.encoding)) as IDeliCheckpoint;
        const term = deli.term;
        const messages = JSON.parse(toUtf8(opsContent.content, opsContent.encoding)) as ISequencedDocumentMessage[];

        return {
            term,
            protocolHead: attributes.sequenceNumber,
            scribe,
            messages,
            fromSummary: true,
        };
    } catch (exception) {
        logger.error("Summary cannot be fetched");
        return {
            term: 1,
            protocolHead: 0,
            scribe: "",
            messages: [],
            fromSummary: false,
        };
    }
}

export const initializeProtocol = (
    documentId: string,
    protocolState: IProtocolState,
    term: number,
): ProtocolOpHandler => new ProtocolOpHandler(
    documentId,
    protocolState.minimumSequenceNumber,
    protocolState.sequenceNumber,
    term,
    protocolState.members,
    protocolState.proposals,
    protocolState.values,
    () => -1,
    () => { return; },
);
