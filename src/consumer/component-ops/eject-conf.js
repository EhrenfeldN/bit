// @flow
import path from 'path';
import R from 'ramda';
import type ConsumerComponent from '../component/consumer-component';
import ComponentBitConfig from '../bit-config';
import { sharedStartOfArray } from '../../utils';
import GeneralError from '../../error/general-error';
import type BitMap from '../bit-map';
import EjectNoDir from './exceptions/eject-no-dir';
import ConfigDir from '../bit-map/config-dir';
import { getLinksByDependencies } from '../../links/link-generator';
import type Consumer from '../consumer';
import CompilerExtension from '../../extensions/compiler-extension';
import TesterExtension from '../../extensions/tester-extension';
import type { PathOsBased } from '../../utils/path';
import DataToPersist from '../component/sources/data-to-persist';
import { COMPILER_ENV_TYPE, TESTER_ENV_TYPE } from '../../constants';
import RemovePath from '../component/sources/remove-path';
import AbstractBitConfig from '../bit-config/abstract-bit-config';

export type EjectConfResult = { id: string, ejectedPath: string, ejectedFullPath: string };
export type EjectConfData = { id: string, ejectedPath: string, ejectedFullPath: string, dataToPersist: DataToPersist };

export default (async function ejectConf(
  component: ConsumerComponent,
  consumer: Consumer,
  configDir: ConfigDir
): Promise<EjectConfResult> {
  const { id, ejectedPath, ejectedFullPath, dataToPersist } = await getEjectConfDataToPersist(
    component,
    consumer,
    configDir
  );
  if (consumer) dataToPersist.addBasePath(consumer.getPath());
  await dataToPersist.persistAllToFS();
  return {
    id,
    ejectedPath,
    ejectedFullPath
  };
});

export async function getEjectConfDataToPersist(
  component: ConsumerComponent,
  consumer: Consumer,
  configDir: ConfigDir
): Promise<EjectConfData> {
  const consumerPath: PathOsBased = consumer.getPath();
  const bitMap: BitMap = consumer.bitMap;
  const oldConfigDir = R.path(['componentMap', 'configDir'], component);
  const componentMap = component.componentMap;
  if (!componentMap) {
    throw new GeneralError('could not find component in the .bitmap file');
  }
  const componentDir = componentMap.getComponentDir();
  if (!componentDir && configDir.isUnderComponentDir) {
    throw new EjectNoDir(component.id.toStringWithoutVersion());
  }
  // In case the user pass a path with the component dir replace it by the {COMPONENT_DIR} DSL
  // (To better support bit move for example)
  if (componentDir) {
    configDir.repalceByComponentDirDSL(componentDir);
  }
  if (!configDir.isUnderComponentDir) {
    const configDirToValidate = _getDirToValidateAgainsetOtherComps(configDir);
    bitMap.validateConfigDir(component.id.toStringWithoutVersion(), configDirToValidate);
  }
  const deleteOldFiles = !!componentMap.configDir && componentMap.configDir !== configDir.linuxDirPath;
  // Passing here the ENV_TYPE as well to make sure it's not removed since we need it later
  const resolvedConfigDir = configDir.getResolved({ componentDir });
  const ejectedCompilerDirectoryP = populateEnvFilesToWrite({
    configDir: resolvedConfigDir.dirPath,
    env: component.compiler,
    consumer,
    component,
    deleteOldFiles,
    verbose: false
  });
  const ejectedTesterDirectoryP = populateEnvFilesToWrite({
    configDir: resolvedConfigDir.dirPath,
    env: component.tester,
    consumer,
    component,
    deleteOldFiles,
    verbose: false
  });
  const [ejectedCompilerDirectory, ejectedTesterDirectory] = await Promise.all([
    ejectedCompilerDirectoryP,
    ejectedTesterDirectoryP
  ]);
  const bitJsonDir = resolvedConfigDir.getEnvTypeCleaned();
  const bitJsonDirFullPath = path.normalize(path.join(consumerPath, bitJsonDir.dirPath));
  const relativeEjectedCompilerDirectory = _getRelativeDir(
    bitJsonDirFullPath,
    consumer.toAbsolutePath(ejectedCompilerDirectory)
  );
  const relativeEjectedTesterDirectory = _getRelativeDir(
    bitJsonDirFullPath,
    consumer.toAbsolutePath(ejectedTesterDirectory)
  );
  const dataToPersist = new DataToPersist();
  if (component.compiler) dataToPersist.merge(component.compiler.dataToPersist);
  if (component.tester) dataToPersist.merge(component.tester.dataToPersist);
  const bitJson = getBitJsonToWrite(component, relativeEjectedCompilerDirectory, relativeEjectedTesterDirectory);
  const jsonFilesToWrite = await bitJson.prepareToWrite({ bitDir: bitJsonDir.dirPath });
  dataToPersist.addManyFiles(jsonFilesToWrite);

  if (deleteOldFiles) {
    if (oldConfigDir) {
      const oldBitJsonDir = oldConfigDir.getResolved({ componentDir }).getEnvTypeCleaned();
      const oldBitJsonDirFullPath = path.join(consumerPath, oldBitJsonDir.dirPath);
      if (bitJsonDirFullPath !== oldBitJsonDirFullPath) {
        const bitJsonToRemove = AbstractBitConfig.composeBitJsonPath(oldBitJsonDir.dirPath);
        dataToPersist.removePath(new RemovePath(bitJsonToRemove, true));
      }
    }
  }
  return {
    id: component.id.toStringWithoutVersion(),
    ejectedPath: configDir.linuxDirPath,
    ejectedFullPath: bitJsonDir.linuxDirPath,
    dataToPersist
  };
}

export async function writeEnvFiles({
  configDir,
  env,
  consumer,
  component,
  deleteOldFiles,
  verbose = false
}: {
  configDir: PathOsBased,
  env?: ?CompilerExtension | ?TesterExtension,
  consumer?: ?Consumer,
  component: ConsumerComponent,
  deleteOldFiles: boolean,
  verbose: boolean
}): Promise<PathOsBased> {
  if (!env) {
    return '';
  }
  const ejectedDirectory = await populateEnvFilesToWrite({
    configDir,
    env,
    consumer,
    component,
    deleteOldFiles,
    verbose
  });
  if (env.dataToPersist) {
    if (consumer) env.dataToPersist.addBasePath(consumer.getPath());
    await env.dataToPersist.persistAllToFS();
  }
  return ejectedDirectory;
}

/**
 * populates the env files into env.dataToPersist
 */
export async function populateEnvFilesToWrite({
  configDir,
  env,
  consumer,
  component,
  deleteOldFiles,
  verbose = false
}: {
  configDir: PathOsBased,
  env?: ?CompilerExtension | ?TesterExtension,
  consumer?: ?Consumer,
  component: ConsumerComponent,
  deleteOldFiles: boolean,
  verbose: boolean
}): Promise<PathOsBased> {
  if (!env) {
    return '';
  }
  const envType = env instanceof CompilerExtension ? COMPILER_ENV_TYPE : TESTER_ENV_TYPE;
  const ejectedDirectory = env.populateDataToPersist({ configDir, deleteOldFiles, consumer, envType, verbose });
  const deps = env instanceof CompilerExtension ? component.compilerDependencies : component.testerDependencies;
  // $FlowFixMe will be fixed with the Capsule feature
  const links = await getLinksByDependencies(configDir, component, deps, consumer);
  env.dataToPersist.addManyFiles(links);
  return ejectedDirectory;
}

const getBitJsonToWrite = (
  component: ConsumerComponent,
  ejectedCompilerDirectory: string,
  ejectedTesterDirectory: string
): ComponentBitConfig => {
  const componentBitConfig = ComponentBitConfig.fromComponent(component);
  componentBitConfig.compiler = component.compiler ? component.compiler.toBitJsonObject(ejectedCompilerDirectory) : {};
  componentBitConfig.tester = component.tester ? component.tester.toBitJsonObject(ejectedTesterDirectory) : {};
  return componentBitConfig;
};

const _getRelativeDir = (bitJsonDir, envDir) => {
  let res = envDir;
  const sharedStart = sharedStartOfArray([bitJsonDir, envDir]);
  if (sharedStart) {
    res = path.relative(sharedStart, envDir);
  }

  return res;
};

/**
 * get the config dir which needed to be searched in other components to validate there is no conflicts
 * That's means check that the dir is not inside the comp dir
 * and get the dir without the dynamic parts
 * @param {*} configDir
 */
const _getDirToValidateAgainsetOtherComps = (configDir: ConfigDir) => {
  // In case it's inside the component dir it can't conflicts with other comps
  if (configDir.isUnderComponentDir) {
    return null;
  }
  return configDir.getCleaned({ cleanComponentDir: false, cleanEnvType: true }).linuxDirPath;
};
