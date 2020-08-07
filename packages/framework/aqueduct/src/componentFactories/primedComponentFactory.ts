/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IFluidObject,
} from "@fluidframework/core-interfaces";
import {
    DirectoryFactory,
    MapFactory,
    SharedDirectory,
    SharedMap,
} from "@fluidframework/map";
import {
    NamedFluidDataStoreRegistryEntries,
} from "@fluidframework/runtime-definitions";
import { IChannelFactory } from "@fluidframework/datastore-definitions";
import { ComponentSymbolProvider } from "@fluidframework/synthesize";

import { DataObject, ISharedComponentProps } from "../components";
import { PureDataObjectFactory } from "./sharedComponentFactory";

/**
 * DataObjectFactory is the IFluidDataStoreFactory for use with PrimedComponents.
 * It facilitates DataObject's features (such as its shared directory) by
 * ensuring relevant shared objects etc are available to the factory.
 *
 * Generics:
 * P - represents a type that will define optional providers that will be injected
 * S - the initial state type that the produced component may take during creation
 */
export class DataObjectFactory<
    P extends IFluidObject = object,
    S = undefined>
    extends PureDataObjectFactory<P, S>
{
    constructor(
        type: string,
        ctor: new (props: ISharedComponentProps<P>) => DataObject<P, S>,
        sharedObjects: readonly IChannelFactory[] = [],
        optionalProviders: ComponentSymbolProvider<P>,
        registryEntries?: NamedFluidDataStoreRegistryEntries,
        onDemandInstantiation = true,
    ) {
        const mergedObjects = [...sharedObjects];

        if (!sharedObjects.find((factory) => factory.type === DirectoryFactory.Type)) {
            // User did not register for directory
            mergedObjects.push(SharedDirectory.getFactory());
        }

        // TODO: Remove SharedMap factory when compatibility with SharedMap DataObject is no longer needed in 0.10
        if (!sharedObjects.find((factory) => factory.type === MapFactory.Type)) {
            // User did not register for map
            mergedObjects.push(SharedMap.getFactory());
        }

        super(
            type,
            ctor,
            mergedObjects,
            optionalProviders,
            registryEntries,
            onDemandInstantiation,
        );
    }
}
