/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ITelemetryLogger } from "@fluidframework/common-definitions";
import {
    IFluidHandle,
    IFluidHandleContext,
    IRequest,
    IResponse,
} from "@fluidframework/core-interfaces";
import {
    IAudience,
    IDeltaManager,
    ContainerWarning,
    ILoader,
    BindState,
    AttachState,
    ILoaderOptions,
} from "@fluidframework/container-definitions";
import {
    assert,
    Deferred,
    TypedEventEmitter,
    unreachableCase,
} from "@fluidframework/common-utils";
import {
    ChildLogger,
    raiseConnectedEvent,
} from "@fluidframework/telemetry-utils";
import { buildSnapshotTree, readAndParseFromBlobs } from "@fluidframework/driver-utils";
import {
    IClientDetails,
    IDocumentMessage,
    IQuorum,
    ISequencedDocumentMessage,
    ITreeEntry,
    SummaryType,
    ISummaryBlob,
    ISummaryTree,
} from "@fluidframework/protocol-definitions";
import {
    CreateSummarizerNodeSource,
    IAttachMessage,
    IChannelSummarizeResult,
    IEnvelope,
    IFluidDataStoreContext,
    IFluidDataStoreChannel,
    IGarbageCollectionData,
    IInboundSignalMessage,
    ISummaryTreeWithStats,
} from "@fluidframework/runtime-definitions";
import {
    convertSnapshotTreeToSummaryTree,
    convertSummaryTreeToITree,
    FluidSerializer,
    generateHandleContextPath,
    RequestParser,
    SummaryTreeBuilder,
} from "@fluidframework/runtime-utils";
import {
    IChannel,
    IFluidDataStoreRuntime,
    IFluidDataStoreRuntimeEvents,
    IChannelFactory,
    IChannelAttributes,
} from "@fluidframework/datastore-definitions";
import {  GCDataBuilder, getChildNodesUsedRoutes } from "@fluidframework/garbage-collector";
import { v4 as uuid } from "uuid";
import { IChannelContext, summarizeChannel } from "./channelContext";
import { LocalChannelContext } from "./localChannelContext";
import { RemoteChannelContext } from "./remoteChannelContext";

export enum DataStoreMessageType {
    // Creates a new channel
    Attach = "attach",
    ChannelOp = "op",
}

export interface ISharedObjectRegistry {
    // TODO consider making this async. A consequence is that either the creation of a distributed data type
    // is async or we need a new API to split the synchronous vs. asynchronous creation.
    get(name: string): IChannelFactory | undefined;
}

/**
 * Base data store class
 */
export class FluidDataStoreRuntime extends
TypedEventEmitter<IFluidDataStoreRuntimeEvents> implements
IFluidDataStoreChannel, IFluidDataStoreRuntime, IFluidHandleContext {
    /**
     * Loads the data store runtime
     * @param context - The data store context
     * @param sharedObjectRegistry - The registry of shared objects used by this data store
     * @param activeCallback - The callback called when the data store runtime in active
     * @param dataStoreRegistry - The registry of data store created and used by this data store
     */
    public static load(
        context: IFluidDataStoreContext,
        sharedObjectRegistry: ISharedObjectRegistry,
    ): FluidDataStoreRuntime {
        return new FluidDataStoreRuntime(context, sharedObjectRegistry);
    }

    public get IFluidRouter() { return this; }

    public get connected(): boolean {
        return this.dataStoreContext.connected;
    }

    public get leader(): boolean {
        return this.dataStoreContext.leader;
    }

    public get clientId(): string | undefined {
        return this.dataStoreContext.clientId;
    }

    public get clientDetails(): IClientDetails {
        return this.dataStoreContext.containerRuntime.clientDetails;
    }

    public get loader(): ILoader {
        return this.dataStoreContext.loader;
    }

    public get isAttached(): boolean {
        return this.attachState !== AttachState.Detached;
    }

    public get attachState(): AttachState {
        return this._attachState;
    }

    /**
     * @deprecated - 0.21 back-compat
     */
    public get path(): string {
        return this.id;
    }

    public get absolutePath(): string {
        return generateHandleContextPath(this.id, this.routeContext);
    }

    public get routeContext(): IFluidHandleContext {
        return this.dataStoreContext.containerRuntime.IFluidHandleContext;
    }

    private readonly serializer = new FluidSerializer(this.IFluidHandleContext);
    public get IFluidSerializer() { return this.serializer; }

    public get IFluidHandleContext() { return this; }

    public get rootRoutingContext() { return this; }
    public get channelsRoutingContext() { return this; }
    public get objectsRoutingContext() { return this; }

    private _disposed = false;
    public get disposed() { return this._disposed; }

    private readonly contexts = new Map<string, IChannelContext>();
    private readonly contextsDeferred = new Map<string, Deferred<IChannelContext>>();
    private readonly pendingAttach = new Map<string, IAttachMessage>();
    private requestHandler: ((request: IRequest) => Promise<IResponse>) | undefined;
    private bindState: BindState;
    // This is used to break the recursion while attaching the graph. Also tells the attach state of the graph.
    private graphAttachState: AttachState = AttachState.Detached;
    private readonly deferredAttached = new Deferred<void>();
    private readonly localChannelContextQueue = new Map<string, LocalChannelContext>();
    private readonly notBoundedChannelContextSet = new Set<string>();
    private boundhandles: Set<IFluidHandle> | undefined;
    private _attachState: AttachState;

    public readonly documentId: string;
    public readonly id: string;
    public existing: boolean;
    public readonly options: ILoaderOptions;
    public readonly deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>;
    private readonly quorum: IQuorum;
    private readonly audience: IAudience;
    public readonly logger: ITelemetryLogger;

    public constructor(
        private readonly dataStoreContext: IFluidDataStoreContext,
        private readonly sharedObjectRegistry: ISharedObjectRegistry,
    ) {
        super();

        this.logger = ChildLogger.create(dataStoreContext.containerRuntime.logger, undefined, { dataStoreId: uuid() });
        this.documentId = dataStoreContext.documentId;
        this.id = dataStoreContext.id;
        this.existing = dataStoreContext.existing;
        this.options = dataStoreContext.options;
        this.deltaManager = dataStoreContext.deltaManager;
        this.quorum = dataStoreContext.getQuorum();
        this.audience = dataStoreContext.getAudience();

        const tree = dataStoreContext.baseSnapshot;

        // Must always receive the data store type inside of the attributes
        if (tree?.trees !== undefined) {
            Object.keys(tree.trees).forEach((path) => {
                // Issue #4414
                if (path === "_search") { return; }

                let channelContext: IChannelContext;
                // If already exists on storage, then create a remote channel. However, if it is case of rehydrating a
                // container from snapshot where we load detached container from a snapshot, isLocalDataStore would be
                // true. In this case create a LocalChannelContext.
                if (dataStoreContext.isLocalDataStore) {
                    const channelAttributes = readAndParseFromBlobs<IChannelAttributes>(
                        tree.trees[path].blobs, tree.trees[path].blobs[".attributes"]);
                    channelContext = new LocalChannelContext(
                        path,
                        this.sharedObjectRegistry,
                        channelAttributes.type,
                        this,
                        this.dataStoreContext,
                        this.dataStoreContext.storage,
                        (content, localOpMetadata) => this.submitChannelOp(path, content, localOpMetadata),
                        (address: string) => this.setChannelDirty(address),
                        tree.trees[path]);
                    // This is the case of rehydrating a detached container from snapshot. Now due to delay loading of
                    // data store, if the data store is loaded after the container is attached, then we missed marking
                    // the channel as attached. So mark it now. Otherwise add it to local channel context queue, so
                    // that it can be mark attached later with the data store.
                    if (dataStoreContext.attachState !== AttachState.Detached) {
                        (channelContext as LocalChannelContext).markAttached();
                    } else {
                        this.localChannelContextQueue.set(path, channelContext as LocalChannelContext);
                    }
                } else {
                    channelContext = new RemoteChannelContext(
                        this,
                        dataStoreContext,
                        dataStoreContext.storage,
                        (content, localOpMetadata) => this.submitChannelOp(path, content, localOpMetadata),
                        (address: string) => this.setChannelDirty(address),
                        path,
                        tree.trees[path],
                        this.sharedObjectRegistry,
                        undefined /* extraBlobs */,
                        this.dataStoreContext.getCreateChildSummarizerNodeFn(
                            path,
                            { type: CreateSummarizerNodeSource.FromSummary },
                        ));
                }
                const deferred = new Deferred<IChannelContext>();
                deferred.resolve(channelContext);

                this.contexts.set(path, channelContext);
                this.contextsDeferred.set(path, deferred);
            });
        }

        this.attachListener();
        // If exists on storage or loaded from a snapshot, it should already be binded.
        this.bindState = this.existing ? BindState.Bound : BindState.NotBound;
        this._attachState = dataStoreContext.attachState;

        // If it's existing we know it has been attached.
        if (this.existing) {
            this.deferredAttached.resolve();
        }
    }

    public dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;

        this.emit("dispose");
        this.removeAllListeners();
    }

    public async resolveHandle(request: IRequest): Promise<IResponse> {
        return this.request(request);
    }

    public async request(request: IRequest): Promise<IResponse> {
        const parser = RequestParser.create(request);
        const id = parser.pathParts[0];

        if (id === "_channels" || id === "_custom") {
            return this.request(parser.createSubRequest(1));
        }

        // Check for a data type reference first
        if (this.contextsDeferred.has(id) && parser.isLeaf(1)) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const value = await this.contextsDeferred.get(id)!.promise;
                const channel = await value.getChannel();

                return { mimeType: "fluid/object", status: 200, value: channel };
            } catch (error) {
                this.logger.sendErrorEvent({ eventName: "GetChannelFailedInRequest" }, error);

                return {
                    status: 500,
                    mimeType: "text/plain",
                    value: `Failed to get Channel with id:[${id}] error:{${error}}`,
                };
            }
        }

        // Otherwise defer to an attached request handler
        if (this.requestHandler === undefined) {
            return { status: 404, mimeType: "text/plain", value: `${request.url} not found` };
        } else {
            return this.requestHandler(parser);
        }
    }

    /**
     * @deprecated
     * Please use mixinRequestHandler() to override default behavior or request()
     * // back-compat: remove in 0.30+
     */
    public registerRequestHandler(handler: (request: IRequest) => Promise<IResponse>) {
        this.requestHandler = handler;
    }

    public async getChannel(id: string): Promise<IChannel> {
        this.verifyNotClosed();

        // TODO we don't assume any channels (even root) in the runtime. If you request a channel that doesn't exist
        // we will never resolve the promise. May want a flag to getChannel that doesn't wait for the promise if
        // it doesn't exist
        if (!this.contextsDeferred.has(id)) {
            this.contextsDeferred.set(id, new Deferred<IChannelContext>());
        }

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const context = await this.contextsDeferred.get(id)!.promise;
        const channel = await context.getChannel();

        return channel;
    }

    public createChannel(id: string = uuid(), type: string): IChannel {
        this.verifyNotClosed();

        assert(!this.contexts.has(id), "createChannel() with existing ID");
        this.notBoundedChannelContextSet.add(id);
        const context = new LocalChannelContext(
            id,
            this.sharedObjectRegistry,
            type,
            this,
            this.dataStoreContext,
            this.dataStoreContext.storage,
            (content, localOpMetadata) => this.submitChannelOp(id, content, localOpMetadata),
            (address: string) => this.setChannelDirty(address),
            undefined);
        this.contexts.set(id, context);

        if (this.contextsDeferred.has(id)) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.contextsDeferred.get(id)!.resolve(context);
        } else {
            const deferred = new Deferred<IChannelContext>();
            deferred.resolve(context);
            this.contextsDeferred.set(id, deferred);
        }

        assert(!!context.channel, "Channel should be loaded when created!!");
        return context.channel;
    }

    /**
     * Binds a channel with the runtime. If the runtime is attached we will attach the channel right away.
     * If the runtime is not attached we will defer the attach until the runtime attaches.
     * @param channel - channel to be registered.
     */
    public bindChannel(channel: IChannel): void {
        assert(this.notBoundedChannelContextSet.has(channel.id), "Channel to be binded should be in not bounded set");
        this.notBoundedChannelContextSet.delete(channel.id);
        // If our data store is attached, then attach the channel.
        if (this.isAttached) {
            this.attachChannel(channel);
            return;
        } else {
            this.bind(channel.handle);

            // If our data store is local then add the channel to the queue
            if (!this.localChannelContextQueue.has(channel.id)) {
                this.localChannelContextQueue.set(channel.id, this.contexts.get(channel.id) as LocalChannelContext);
            }
        }
    }

    public attachGraph() {
        if (this.graphAttachState !== AttachState.Detached) {
            return;
        }
        this.graphAttachState = AttachState.Attaching;
        if (this.boundhandles !== undefined) {
            this.boundhandles.forEach((handle) => {
                handle.attachGraph();
            });
            this.boundhandles = undefined;
        }

        // Flush the queue to set any pre-existing channels to local
        this.localChannelContextQueue.forEach((channel) => {
            // When we are attaching the data store we don't need to send attach for the registered services.
            // This is because they will be captured as part of the Attach data store snapshot
            channel.markAttached();
        });

        this.localChannelContextQueue.clear();
        this.bindToContext();
        this.graphAttachState = AttachState.Attached;
    }

    /**
     * Binds this runtime to the container
     * This includes the following:
     * 1. Sending an Attach op that includes all existing state
     * 2. Attaching the graph if the data store becomes attached.
     */
    public bindToContext() {
        if (this.bindState !== BindState.NotBound) {
            return;
        }
        this.bindState = BindState.Binding;
        // Attach the runtime to the container via this callback
        // back-compat: remove argument ans cast in 0.30.
        (this.dataStoreContext as any).bindToContext(this);

        this.bindState = BindState.Bound;
    }

    public bind(handle: IFluidHandle): void {
        // If the data store is already attached or its graph is already in attaching or attached state,
        // then attach the incoming handle too.
        if (this.isAttached || this.graphAttachState !== AttachState.Detached) {
            handle.attachGraph();
            return;
        }
        if (this.boundhandles === undefined) {
            this.boundhandles = new Set<IFluidHandle>();
        }

        this.boundhandles.add(handle);
    }

    public setConnectionState(connected: boolean, clientId?: string) {
        this.verifyNotClosed();

        for (const [, object] of this.contexts) {
            object.setConnectionState(connected, clientId);
        }

        raiseConnectedEvent(this.logger, this, connected, clientId);
    }

    public getQuorum(): IQuorum {
        return this.quorum;
    }

    public getAudience(): IAudience {
        return this.audience;
    }

    public async uploadBlob(blob: ArrayBufferLike): Promise<IFluidHandle<ArrayBufferLike>> {
        this.verifyNotClosed();

        return this.dataStoreContext.uploadBlob(blob);
    }

    public process(message: ISequencedDocumentMessage, local: boolean, localOpMetadata: unknown) {
        this.verifyNotClosed();
        switch (message.type) {
            case DataStoreMessageType.Attach: {
                const attachMessage = message.contents as IAttachMessage;
                const id = attachMessage.id;

                // If a non-local operation then go and create the object
                // Otherwise mark it as officially attached.
                if (local) {
                    assert(this.pendingAttach.has(id), "Unexpected attach (local) channel OP");
                    this.pendingAttach.delete(id);
                } else {
                    assert(!this.contexts.has(id), `Unexpected attach channel OP,
                        is in pendingAttach set: ${this.pendingAttach.has(id)},
                        is local channel contexts: ${this.contexts.get(id) instanceof LocalChannelContext}`);

                    const flatBlobs = new Map<string, string>();
                    const snapshotTree = buildSnapshotTree(attachMessage.snapshot.entries, flatBlobs);

                    const remoteChannelContext = new RemoteChannelContext(
                        this,
                        this.dataStoreContext,
                        this.dataStoreContext.storage,
                        (content, localContentMetadata) => this.submitChannelOp(id, content, localContentMetadata),
                        (address: string) => this.setChannelDirty(address),
                        id,
                        snapshotTree,
                        this.sharedObjectRegistry,
                        flatBlobs,
                        this.dataStoreContext.getCreateChildSummarizerNodeFn(
                            id,
                            {
                                type: CreateSummarizerNodeSource.FromAttach,
                                sequenceNumber: message.sequenceNumber,
                                snapshot: attachMessage.snapshot,
                            },
                        ),
                        attachMessage.type);

                    this.contexts.set(id, remoteChannelContext);
                    if (this.contextsDeferred.has(id)) {
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        this.contextsDeferred.get(id)!.resolve(remoteChannelContext);
                    } else {
                        const deferred = new Deferred<IChannelContext>();
                        deferred.resolve(remoteChannelContext);
                        this.contextsDeferred.set(id, deferred);
                    }
                }
                break;
            }

            case DataStoreMessageType.ChannelOp:
                this.processChannelOp(message, local, localOpMetadata);
                break;
            default:
        }

        this.emit("op", message);
    }

    public processSignal(message: IInboundSignalMessage, local: boolean) {
        this.emit("signal", message, local);
    }

    private isChannelAttached(id: string): boolean {
        return (
            // Added in createChannel
            // Removed when bindChannel is called
            !this.notBoundedChannelContextSet.has(id)
            // Added in bindChannel only if this is not attached yet
            // Removed when this is attached by calling attachGraph
            && !this.localChannelContextQueue.has(id)
            // Added in attachChannel called by bindChannel
            // Removed when attach op is broadcast
            && !this.pendingAttach.has(id)
        );
    }

    // back-compat for N-2 <= 0.28, remove when N-2 >= 0.29
    public async snapshotInternal(fullTree: boolean = false): Promise<ITreeEntry[]> {
        const summaryTree = await this.summarize(fullTree);
        const tree = convertSummaryTreeToITree(summaryTree.summary);
        return tree.entries;
    }

    /**
     * Returns the outbound routes of this channel. Currently, all contexts in this channel are considered
     * referenced and are hence outbound. This will change when we have root and non-root channel contexts.
     * The only root contexts will be considered as referenced.
     */
    private getOutboundRoutes(): string[] {
        const outboundRoutes: string[] = [];
        for (const [contextId] of this.contexts) {
            outboundRoutes.push(`${this.absolutePath}/${contextId}`);
        }
        return outboundRoutes;
    }

    /**
     * Updates the GC nodes of this channel. It does the following:
     * - Adds a back route to self to all its child GC nodes.
     * - Adds a node for this channel.
     * @param builder - The builder that contains the GC nodes for this channel's children.
     */
    private updateGCNodes(builder: GCDataBuilder) {
        // Add a back route to self in each child's GC nodes. If any child is referenced, then its parent should
        // be considered referenced as well.
        builder.addRouteToAllNodes(this.absolutePath);

        // Get the outbound routes and add a GC node for this channel.
        builder.addNode("/", this.getOutboundRoutes());
    }

    /**
     * Generates data used for garbage collection. This includes a list of GC nodes that represent this channel
     * including any of its child channel contexts. Each node has a set of outbound routes to other GC nodes in the
     * document. It does the following:
     * 1. Calls into each child context to get its GC data.
     * 2. Prefixs the child context's id to the GC nodes in the child's GC data. This makes sure that the node can be
     *    idenfied as belonging to the child.
     * 3. Adds a GC node for this channel to the nodes received from the children. All these nodes together represent
     *    the GC data of this channel.
     */
    public async getGCData(): Promise<IGarbageCollectionData> {
        const builder = new GCDataBuilder();
        // Iterate over each channel context and get their GC data.
        await Promise.all(Array.from(this.contexts)
            .filter(([contextId, _]) => {
                // Get GC data only for attached contexts. Detached contexts are not connected in the GC reference
                // graph so any references they might have won't be connected as well.
                return this.isChannelAttached(contextId);
            }).map(async ([contextId, context]) => {
                const contextGCData = await context.getGCData();
                // Prefix the child's id to the ids of its GC nodes so they can be identified as belonging to the child.
                // This also gradually builds the id of each node to be a path from the root.
                builder.prefixAndAddNodes(contextId, contextGCData.gcNodes);
            }));

        this.updateGCNodes(builder);
        return builder.getGCData();
    }

    /**
     * After GC has run, called to notify this channel of routes that are used in it. It calls the child contexts to
     * update their used routes.
     * @param usedRoutes - The routes that are used in all contexts in this channel.
     */
    public updateUsedRoutes(usedRoutes: string[]) {
        // Get a map of channel ids to routes used in it.
        const usedContextRoutes = getChildNodesUsedRoutes(usedRoutes);

        // Verify that the used routes are correct.
        for (const [id] of usedContextRoutes) {
            assert(this.contexts.has(id), "Used route does not belong to any known context");
        }

        // Update the used routes in each context. Used routes is empty for unused context.
        for (const [contextId, context] of this.contexts) {
            context.updateUsedRoutes(usedContextRoutes.get(contextId) ?? []);
        }
    }

    /**
     * Returns a summary at the current sequence number.
     * @param fullTree - true to bypass optimizations and force a full summary tree
     * @param trackState - This tells whether we should track state from this summary.
     */
    public async summarize(fullTree: boolean = false, trackState: boolean = true): Promise<IChannelSummarizeResult> {
        const gcDataBuilder = new GCDataBuilder();
        const summaryBuilder = new SummaryTreeBuilder();

        // Iterate over each data store and ask it to summarize
        await Promise.all(Array.from(this.contexts)
            .filter(([contextId, _]) => {
                const isAttached = this.isChannelAttached(contextId);
                // We are not expecting local dds! Summary may not capture local state.
                assert(isAttached, "Not expecting detached channels during summarize");
                // If the object is registered - and we have received the sequenced op creating the object
                // (i.e. it has a base mapping) - then we go ahead and summarize
                return isAttached;
            }).map(async ([contextId, context]) => {
                const contextSummary = await context.summarize(fullTree, trackState);
                summaryBuilder.addWithStats(contextId, contextSummary);

                // back-compat 0.31 - Older versions will not have GC data in summary.
                if (contextSummary.gcData !== undefined) {
                    // Prefix the child's id to the ids of its GC nodes. This gradually builds the id of each node
                    // to be a path from the root.
                    gcDataBuilder.prefixAndAddNodes(contextId, contextSummary.gcData.gcNodes);
                }
            }));

        this.updateGCNodes(gcDataBuilder);
        return {
            ...summaryBuilder.getSummaryTree(),
            gcData: gcDataBuilder.getGCData(),
        };
    }

    public getAttachSummary(): IChannelSummarizeResult {
        this.attachGraph();

        const gcDataBuilder = new GCDataBuilder();
        const summaryBuilder = new SummaryTreeBuilder();

        // Craft the .attributes file for each shared object
        for (const [contextId, context] of this.contexts) {
            if (!(context instanceof LocalChannelContext)) {
                throw new Error("Should only be called with local channel handles");
            }

            if (!this.notBoundedChannelContextSet.has(contextId)) {
                let summaryTree: ISummaryTreeWithStats;
                if (context.isLoaded) {
                    const contextSummary = context.getAttachSummary();
                    assert(
                        contextSummary.summary.type === SummaryType.Tree,
                        "getAttachSummary should always return a tree");
                    summaryTree = { stats: contextSummary.stats, summary: contextSummary.summary };

                    // back-compat 0.31 - Older versions will not have GC data in summary.
                    if (contextSummary.gcData !== undefined) {
                        // Prefix the child's id to the ids of its GC nodest. This gradually builds the id of each node
                        // to be a path from the root.
                        gcDataBuilder.prefixAndAddNodes(contextId, contextSummary.gcData.gcNodes);
                    }
                } else {
                    // If this channel is not yet loaded, then there should be no changes in the snapshot from which
                    // it was created as it is detached container. So just use the previous snapshot.
                    assert(!!this.dataStoreContext.baseSnapshot,
                        "BaseSnapshot should be there as detached container loaded from snapshot");
                    summaryTree = convertSnapshotTreeToSummaryTree(this.dataStoreContext.baseSnapshot.trees[contextId]);
                }
                summaryBuilder.addWithStats(contextId, summaryTree);
            }
        }

        this.updateGCNodes(gcDataBuilder);
        return {
            ...summaryBuilder.getSummaryTree(),
            gcData: gcDataBuilder.getGCData(),
        };
    }

    public submitMessage(type: DataStoreMessageType, content: any, localOpMetadata: unknown) {
        this.submit(type, content, localOpMetadata);
    }

    public submitSignal(type: string, content: any) {
        this.verifyNotClosed();
        return this.dataStoreContext.submitSignal(type, content);
    }

    /**
     * Will return when the data store is attached.
     */
    public async waitAttached(): Promise<void> {
        return this.deferredAttached.promise;
    }

    public raiseContainerWarning(warning: ContainerWarning): void {
        this.dataStoreContext.raiseContainerWarning(warning);
    }

    /**
     * Attach channel should only be called after the data store has been attached
     */
    private attachChannel(channel: IChannel): void {
        this.verifyNotClosed();
        // If this handle is already attached no need to attach again.
        if (channel.handle.isAttached) {
            return;
        }

        channel.handle.attachGraph();

        assert(this.isAttached, "Data store should be attached to attach the channel.");
        // Get the object snapshot only if the data store is Bound and its graph is attached too,
        // because if the graph is attaching, then it would get included in the data store snapshot.
        if (this.bindState === BindState.Bound && this.graphAttachState === AttachState.Attached) {
            const summarizeResult = summarizeChannel(channel, true /* fullTree */, false /* trackState */);
            // Attach message needs the summary in ITree format. Convert the ISummaryTree into an ITree.
            const snapshot = convertSummaryTreeToITree(summarizeResult.summary);

            const message: IAttachMessage = {
                id: channel.id,
                snapshot,
                type: channel.attributes.type,
            };
            this.pendingAttach.set(channel.id, message);
            this.submit(DataStoreMessageType.Attach, message);
        }

        const context = this.contexts.get(channel.id) as LocalChannelContext;
        context.markAttached();
    }

    private submitChannelOp(address: string, contents: any, localOpMetadata: unknown) {
        const envelope: IEnvelope = { address, contents };
        this.submit(DataStoreMessageType.ChannelOp, envelope, localOpMetadata);
    }

    private submit(
        type: DataStoreMessageType,
        content: any,
        localOpMetadata: unknown = undefined): void {
        this.verifyNotClosed();
        this.dataStoreContext.submitMessage(type, content, localOpMetadata);
    }

    /**
     * For messages of type MessageType.Operation, finds the right channel and asks it to resubmit the message.
     * For all other messages, just submit it again.
     * This typically happens when we reconnect and there are unacked messages.
     * @param content - The content of the original message.
     * @param localOpMetadata - The local metadata associated with the original message.
     */
    public reSubmit(type: DataStoreMessageType, content: any, localOpMetadata: unknown) {
        this.verifyNotClosed();

        switch (type) {
            case DataStoreMessageType.ChannelOp:
                {
                    // For Operations, find the right channel and trigger resubmission on it.
                    const envelope = content as IEnvelope;
                    const channelContext = this.contexts.get(envelope.address);
                    assert(!!channelContext, "There should be a channel context for the op");
                    channelContext.reSubmit(envelope.contents, localOpMetadata);
                    break;
                }
            case DataStoreMessageType.Attach:
                // For Attach messages, just submit them again.
                this.submit(type, content, localOpMetadata);
                break;
            default:
                unreachableCase(type);
        }
    }

    public async rebaseOp(content: any, localOpMetadata: unknown) {
        const envelope = content as IEnvelope;
        const channelContext = this.contexts.get(envelope.address);
        assert(!!channelContext, "There should be a channel context for the op");
        await channelContext.getChannel();
        channelContext.rebaseOp(envelope.contents, localOpMetadata);
    }

    private setChannelDirty(address: string): void {
        this.verifyNotClosed();
        this.dataStoreContext.setChannelDirty(address);
    }

    private processChannelOp(message: ISequencedDocumentMessage, local: boolean, localOpMetadata: unknown) {
        this.verifyNotClosed();

        const envelope = message.contents as IEnvelope;

        const transformed: ISequencedDocumentMessage = {
            ...message,
            contents: envelope.contents,
        };

        const channelContext = this.contexts.get(envelope.address);
        assert(!!channelContext, "Channel not found");
        channelContext.processOp(transformed, local, localOpMetadata);

        return channelContext;
    }

    private attachListener() {
        this.setMaxListeners(Number.MAX_SAFE_INTEGER);
        this.dataStoreContext.on("leader", () => {
            this.emit("leader");
        });
        this.dataStoreContext.on("notleader", () => {
            this.emit("notleader");
        });
        this.dataStoreContext.once("attaching", () => {
            assert(this.bindState !== BindState.NotBound, "Data store attaching should not occur if it is not bound");
            this._attachState = AttachState.Attaching;
            // This promise resolution will be moved to attached event once we fix the scheduler.
            this.deferredAttached.resolve();
            this.emit("attaching");
        });
        this.dataStoreContext.once("attached", () => {
            assert(this.bindState === BindState.Bound, "Data store should only be attached after it is bound");
            this._attachState = AttachState.Attached;
            this.emit("attached");
        });
    }

    private verifyNotClosed() {
        if (this._disposed) {
            throw new Error("Runtime is closed");
        }
    }
}

/**
 * Mixin class that adds request handler to FluidDataStoreRuntime
 * Request handler is only called when data store can't resolve request, i.e. for custom requests.
 * @param Base - base class, inherits from FluidDataStoreRuntime
 * @param requestHandler - request handler to mix in
 */
export function mixinRequestHandler(
    requestHandler: (request: IRequest, runtime: FluidDataStoreRuntime) => Promise<IResponse>,
    Base: typeof FluidDataStoreRuntime = FluidDataStoreRuntime)
{
    return class RuntimeWithRequestHandler extends Base {
        public async request(request: IRequest) {
            const response  = await super.request(request);
            if (response.status === 404) {
                return requestHandler(request, this);
            }
            return response;
        }
    } as typeof FluidDataStoreRuntime;
}

/**
 * Mixin class that adds await for DataObject to finish initialization before we proceed to summary.
 * @param Base - base class, inherits from FluidDataStoreRuntime
 */
export function mixinSummaryHandler(
    handler: (runtime: FluidDataStoreRuntime) => Promise<{ path: string[], content: string }>,
    Base: typeof FluidDataStoreRuntime = FluidDataStoreRuntime,
    )
{
    return class RuntimeWithSummarizerHandler extends Base {
        private addBlob(summary: ISummaryTreeWithStats, path: string[], content: string) {
            const firstName = path.shift();
            if (firstName === undefined) {
                throw new Error("Path can't be empty");
            }

            let blob: ISummaryTree | ISummaryBlob = {
                type: SummaryType.Blob,
                content,
            };
            summary.stats.blobNodeCount++;
            summary.stats.totalBlobSize += content.length;

            for (const name of path.reverse()) {
                blob = {
                    type: SummaryType.Tree,
                    tree: { [name]: blob },
                };
                summary.stats.treeNodeCount++;
            }
            summary.summary.tree[firstName] = blob;
        }

        async summarize(...args: any[]) {
            const summary = await super.summarize(...args);
            const content = await handler(this);
            this.addBlob(summary, content.path, content.content);
            return summary;
        }
    } as typeof FluidDataStoreRuntime;
}
