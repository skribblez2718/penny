/** The builder inserts this check into every compiled module, including direct CLI entrypoints. */
import { assertCurrentShippingBuild } from "./build-provenance.js";

assertCurrentShippingBuild();
