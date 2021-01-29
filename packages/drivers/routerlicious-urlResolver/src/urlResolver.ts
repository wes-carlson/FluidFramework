/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { parse } from "url";
import { assert } from "@fluidframework/common-utils";
import {
    IRequest,
} from "@fluidframework/core-interfaces";
import {
    IFluidResolvedUrl,
    IResolvedUrl,
    IUrlResolver,
} from "@fluidframework/driver-definitions";
import { IUser } from "@fluidframework/protocol-definitions";
import { Provider } from "nconf";

const r11sServers = [
    "www.wu2-ppe.prague.office-int.com",
    "www.wu2.prague.office-int.com",
    "www.eu.prague.office-int.com",
];

export class RouterliciousUrlResolver implements IUrlResolver {
    constructor(
        private readonly config: { provider: Provider, tenantId: string, documentId: string } | undefined,
        private readonly getToken: () => Promise<string>,
        private readonly hostUrl: string) {
    }

    /**
     * Handles a request and returns the relevant endpoints for the environment
     */
    public async resolve(request: IRequest): Promise<IResolvedUrl | undefined> {
        let requestedUrl = request.url;

        // If we know the original hostname, reinsert it
        if (this.config && request.url.startsWith("/")) {
            requestedUrl = `http://dummy:3000${request.url}`;
        }

        const reqUrl = new URL(requestedUrl);
        const server = reqUrl.hostname.toLowerCase();

        // If we don't have a valid server or a prescriptive config, we cannot resolve the URL
        if (!(r11sServers.includes(server) || (server === "localhost" && reqUrl.port === "3000") || this.config)) {
            return undefined;
        }

        const path = reqUrl.pathname.split("/");
        let tenantId: string;
        let documentId: string;
        let provider: Provider | undefined;
        if (this.config) {
            tenantId = this.config.tenantId;
            documentId = this.config.documentId;
            provider = this.config.provider;
        } else if (path.length >= 4) {
            tenantId = path[2];
            documentId = path[3];
        } else {
            tenantId = "fluid";
            documentId = path[2];
        }

        const token = await this.getToken();

        const isLocalHost = server === "localhost";
        const isInternalRequest = server.includes("gateway"); // e.g. gateway:3000 || fierce-dog-gateway:3000

        const serverSuffix = isLocalHost ? `${server}:3003` : server.substring(4);

        let fluidUrl = "fluid://" +
            `${this.config ? parse(this.config.provider.get("worker:serverUrl")).host : serverSuffix}/` +
            `${encodeURIComponent(tenantId)}/` +
            `${encodeURIComponent(documentId)}`;

        // In case of any additional parameters add them back to the url
        if (reqUrl.search) {
            const searchParams = reqUrl.search;
            if (searchParams) {
                fluidUrl += searchParams;
            }
        }

        let storageUrl = "";
        let ordererUrl = "";
        let deltaStorageUrl = "";

        // There is no provider when using debugging tooling
        if (provider && isInternalRequest) {
            storageUrl = provider.get("worker:internalBlobStorageUrl");
            ordererUrl = provider.get("worker:alfredUrl");
            deltaStorageUrl =
                // eslint-disable-next-line max-len
                `${provider.get("worker:alfredUrl")}/deltas/${encodeURIComponent(tenantId)}/${encodeURIComponent(documentId)}`;
        } else if (provider) {
            storageUrl = provider.get("worker:blobStorageUrl").replace("historian:3000", "localhost:3001");
            ordererUrl = provider.get("worker:serverUrl");
            deltaStorageUrl =
                `${ordererUrl}/deltas/${encodeURIComponent(tenantId)}/${encodeURIComponent(documentId)}`;
        } else if (isLocalHost) {
            storageUrl = `http://localhost:3001`;
            ordererUrl = `http://localhost:3003`;
            deltaStorageUrl = `http://localhost:3003/deltas/${tenantId}/${documentId}`;
        } else {
            storageUrl = `https://historian.${serverSuffix}`;
            ordererUrl = `https://alfred.${serverSuffix}`;
            deltaStorageUrl = `https://alfred.${serverSuffix}/deltas/${tenantId}/${documentId}`;
        }

        storageUrl += `/repos/${tenantId}`;
        ordererUrl += ``;
        deltaStorageUrl += ``;

        const resolved: IFluidResolvedUrl = {
            endpoints: {
                storageUrl,
                deltaStorageUrl,
                ordererUrl,
            },
            tokens: { jwt: token },
            type: "fluid",
            url: fluidUrl,
        };
        return resolved;
    }

    public async getAbsoluteUrl(
        resolvedUrl: IResolvedUrl,
        relativeUrl: string,
    ): Promise<string> {
        const fluidResolvedUrl = resolvedUrl as IFluidResolvedUrl;

        const parsedUrl = parse(fluidResolvedUrl.url);
        const [, tenantId, documentId] = parsedUrl.pathname?.split("/");
        assert(!!tenantId, "Tenant id should exist");
        assert(!!documentId, "Document id should exist");

        let url = relativeUrl;
        if (url.startsWith("/")) {
            url = url.substr(1);
        }

        return `${this.hostUrl}/${encodeURIComponent(
            tenantId)}/${encodeURIComponent(documentId)}/${url}`;
    }
}

export interface IAlfredUser extends IUser {
    displayName: string;
    name: string;
}

export interface IConfig {
    serverUrl: string;
    blobStorageUrl: string;
    tenantId: string;
    documentId: string;
}
