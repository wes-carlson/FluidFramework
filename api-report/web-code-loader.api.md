## API Report File for "@fluidframework/web-code-loader"

> Do not edit this file. It is a report generated by [API Extractor](https://api-extractor.com/).

```ts

import { ICodeAllowList } from '@fluidframework/container-definitions';
import { ICodeLoader } from '@fluidframework/container-definitions';
import { IFluidCodeDetails } from '@fluidframework/core-interfaces';
import { IFluidCodeResolver } from '@fluidframework/container-definitions';
import { IFluidModule } from '@fluidframework/container-definitions';
import { IFluidPackage } from '@fluidframework/core-interfaces';
import { IFluidPackageEnvironment } from '@fluidframework/core-interfaces';
import { IResolvedFluidCodeDetails } from '@fluidframework/container-definitions';

// @public
export class AllowList implements ICodeAllowList {
    constructor(testHandler?: ((source: IResolvedFluidCodeDetails) => Promise<boolean>) | undefined);
    // (undocumented)
    testSource(source: IResolvedFluidCodeDetails): Promise<boolean>;
}

// @public (undocumented)
export function extractPackageIdentifierDetails(codeDetailsPackage: string | IFluidPackage): IPackageIdentifierDetails;

// @public (undocumented)
export interface IPackageIdentifierDetails {
    // (undocumented)
    readonly fullId: string;
    // (undocumented)
    readonly name: string;
    // (undocumented)
    readonly nameAndVersion: string;
    // (undocumented)
    readonly scope: string;
    // (undocumented)
    readonly version: string | undefined;
}

// @public (undocumented)
export function resolveFluidPackageEnvironment(environment: IFluidPackageEnvironment, baseUrl: string): Readonly<IFluidPackageEnvironment>;

// @public
export class SemVerCdnCodeResolver implements IFluidCodeResolver {
    // (undocumented)
    resolveCodeDetails(codeDetails: IFluidCodeDetails): Promise<IResolvedFluidCodeDetails>;
}

// @public (undocumented)
export class WebCodeLoader implements ICodeLoader {
    constructor(codeResolver: IFluidCodeResolver, allowList?: ICodeAllowList | undefined);
    // (undocumented)
    load(source: IFluidCodeDetails): Promise<IFluidModule>;
    // (undocumented)
    preCache(source: IFluidCodeDetails): Promise<void>;
    // (undocumented)
    seedModule(source: IFluidCodeDetails, maybeFluidModule?: Promise<IFluidModule> | IFluidModule): Promise<void>;
}


// (No @packageDocumentation comment for this package)

```
