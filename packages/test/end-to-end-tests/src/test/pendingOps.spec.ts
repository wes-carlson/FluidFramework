/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";
import { IContainer, ILoader } from "@fluidframework/container-definitions";
import { SharedMap } from "@fluidframework/map";
import { requestFluidObject } from "@fluidframework/runtime-utils";
import { ChannelFactoryRegistry, createAndAttachContainer, ITestFluidObject } from "@fluidframework/test-utils";
import {
    DataObjectFactoryType,
    generateTest,
    ICompatLocalTestObjectProvider,
    ITestContainerConfig,
} from "./compatUtils";

const mapId = "map";
const registry: ChannelFactoryRegistry = [[mapId, SharedMap.getFactory()]];
const testContainerConfig: ITestContainerConfig = {
    fluidDataObjectType: DataObjectFactoryType.Test,
    registry,
};

const getSnapshot = (container: IContainer) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        (container as any).context.runtime.pendingStateManager.snapshot();

const watchContainer = (container) => {
    container.on("op", (op) => {
        console.log("*".repeat(100));
        if (op.type === "op") {
            console.log(op.type);
            console.log(op);
            console.log("-".repeat(100));
            console.log(op?.contents?.contents);
            console.log("-".repeat(100));
            console.log(op?.contents?.contents?.contents?.content);
        } else if (op.type === "join") {
            console.log(op.type, JSON.parse(op.data).clientId);
            console.log(op);
        } else {
            console.log(op);
        }
        console.log("*".repeat(100));
    });
};

const testKey = "test key";
const testValue = "test value";

const tests = (args: ICompatLocalTestObjectProvider) => {
    let loader: ILoader;
    let container1: IContainer;
    let map1: SharedMap;
    beforeEach(async () => {
        loader = args.makeTestLoader(testContainerConfig);
        container1 = await createAndAttachContainer(
            "defaultDocumentId",
            args.defaultCodeDetails,
            loader,
            args.urlResolver);
        watchContainer(container1);
        const dataStore1 = await requestFluidObject<ITestFluidObject>(container1, "default");
        map1 = await dataStore1.getSharedObject<SharedMap>(mapId);
    });

    it("resends op", async function() {
        // load container and pause, send op, get pending ops, close container
        const container2: IContainer = await args.loadTestContainer(testContainerConfig);
        args.opProcessingController.addDeltaManagers(container2.deltaManager as any);
        await args.opProcessingController.pauseProcessing(container2.deltaManager as any);
        const dataStore2 = await requestFluidObject<ITestFluidObject>(container2, "default");
        assert(dataStore2.runtime.deltaManager.outbound.paused);
        const map2 = await dataStore2.getSharedObject<SharedMap>(mapId);
        map2.set(testKey, testValue);
        const pendingOps = getSnapshot(container2);
        assert.ok(pendingOps);
        container2.close();

        // load container with pending ops, which should resend the op not sent by previous container
        const container3: IContainer = await (loader as any).resolveWithPendingOps(
            { url: "http://localhost:3000/defaultDocumentId", headers: { "fluid-cache": false } },
            pendingOps,
        );
        args.opProcessingController.addDeltaManagers(container3.deltaManager as any);
        const dataStore3 = await requestFluidObject<ITestFluidObject>(container3, "default");
        const map3 = await dataStore3.getSharedObject<SharedMap>(mapId);
        assert.strictEqual(await map1.wait(testKey), testValue);
        assert.strictEqual(await map3.wait(testKey), testValue);
    });

    it("doesn't resend successful op", async function() {
        // load container and pause, send op, get pending ops, resume container
        const container2 = await args.loadTestContainer(testContainerConfig);
        const dataStore2 = await requestFluidObject<ITestFluidObject>(container2, "default");
        const map2 = await dataStore2.getSharedObject<SharedMap>(mapId);
        await new Promise((res) => container2.on("connected", res));
        await args.opProcessingController.process();
        await args.opProcessingController.pauseProcessing(container2.deltaManager as any);
        map2.set(testKey, testValue);
        const pendingOps = getSnapshot(container2);
        assert.ok(pendingOps);
        console.log(pendingOps);
        await args.opProcessingController.process();
        container2.close();

        container1.on("op", (op) => {
            if (op.contents?.contents?.address === "default") {
                assert.strictEqual(op.clientId, (container2 as any).clientId);
            }
        });

        // load with pending ops, which it should not resend because they were already sent successfully
        const container3: IContainer = await (loader as any).resolveWithPendingOps(
            { url: "http://localhost:3000/defaultDocumentId", headers: { "fluid-cache": false } },
            pendingOps,
        );
        args.opProcessingController.addDeltaManagers(container3.deltaManager as any);
        const dataStore3 = await requestFluidObject<ITestFluidObject>(container3, "default");
        const map3 = await dataStore3.getSharedObject<SharedMap>(mapId);

        // wait to see if the op is resent
        await args.opProcessingController.process();

        assert.strictEqual(await map1.wait(testKey), testValue);
        assert.strictEqual(await map3.wait(testKey), testValue);
    });

    it("resends a lot of ops", async function() {
        // load container and pause, send ops, get pending ops, close container
        const container2: IContainer = await args.loadTestContainer(testContainerConfig);
        args.opProcessingController.addDeltaManagers(container2.deltaManager as any);
        await args.opProcessingController.pauseProcessing(container2.deltaManager as any);
        const dataStore2 = await requestFluidObject<ITestFluidObject>(container2, "default");
        assert(dataStore2.runtime.deltaManager.outbound.paused);
        const map2 = await dataStore2.getSharedObject<SharedMap>(mapId);

        [...Array(50).keys()].map((i) => map2.set(i.toString(), i));
        const pendingOps = getSnapshot(container2);
        assert.ok(pendingOps);
        container2.close();

        // load container with pending ops, which should resend the ops not sent by previous container
        const container3: IContainer = await (loader as any).resolveWithPendingOps(
            { url: "http://localhost:3000/defaultDocumentId", headers: { "fluid-cache": false } },
            pendingOps,
        );
        args.opProcessingController.addDeltaManagers(container3.deltaManager as any);
        const dataStore3 = await requestFluidObject<ITestFluidObject>(container3, "default");
        const map3 = await dataStore3.getSharedObject<SharedMap>(mapId);
        await Promise.all([...Array(50).keys()].map(async (i) => assert.strictEqual(await map1.wait(i.toString()), i)));
        await Promise.all([...Array(50).keys()].map(async (i) => assert.strictEqual(await map3.wait(i.toString()), i)));
    });

    it("doesn't resend a lot of successful ops", async function() {
        // load container and pause, send ops, get pending ops, resume container
        const container2: IContainer = await args.loadTestContainer(testContainerConfig);
        args.opProcessingController.addDeltaManagers(container2.deltaManager as any);
        await new Promise((res) => container2.on("connected", res));
        await args.opProcessingController.process();
        await args.opProcessingController.pauseProcessing(container2.deltaManager as any);
        const dataStore2 = await requestFluidObject<ITestFluidObject>(container2, "default");
        assert(dataStore2.runtime.deltaManager.outbound.paused);
        const map2 = await dataStore2.getSharedObject<SharedMap>(mapId);

        [...Array(10).keys()].map((i) => map2.set(i.toString(), i));
        const pendingOps = getSnapshot(container2);
        assert.ok(pendingOps);
        console.log(pendingOps);
        await args.opProcessingController.process();
        container2.close();

        // send a bunch from first container that should not be overwritten
        [...Array(10).keys()].map((i) => map1.set(i.toString(), testValue));

        // load container with pending ops, which should not resend the ops sent by previous container
        const container3: IContainer = await (loader as any).resolveWithPendingOps(
            { url: "http://localhost:3000/defaultDocumentId", headers: { "fluid-cache": false } },
            pendingOps,
        );
        args.opProcessingController.addDeltaManagers(container3.deltaManager as any);
        const dataStore3 = await requestFluidObject<ITestFluidObject>(container3, "default");
        const map3 = await dataStore3.getSharedObject<SharedMap>(mapId);
        await args.opProcessingController.process();
        await Promise.all([...Array(10).keys()].map(
            async (i) => assert.strictEqual(await map1.wait(i.toString()), testValue)));
        // [...Array(10).keys()].map(async (i) => console.log(await map3.wait(i.toString())));
        await Promise.all([...Array(10).keys()].map(
            async (i) => assert.strictEqual(await map3.wait(i.toString()), testValue)));
    });
};

describe("asdf", () => {
    generateTest(tests);
});
