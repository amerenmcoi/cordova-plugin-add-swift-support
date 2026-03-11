/*
 * Modernized Swift support hook for Cordova iOS.
 *
 * What this does:
 * - Locates the real .xcodeproj dynamically instead of assuming config.xml app name
 * - Ensures a bridging header exists and imports <Cordova/CDV.h>
 * - Merges any plugin-provided Bridging-Header*.h files into the main bridging header
 * - Sets SWIFT_OBJC_BRIDGING_HEADER if needed
 * - Enables ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES if needed
 * - Sets LD_RUNPATH_SEARCH_PATHS if needed
 * - Uses UseSwiftLanguageVersion from config.xml if explicitly provided
 *
 * What this does NOT do:
 * - Does not force an ancient iOS deployment target like 7.0
 * - Does not force Swift 4.0
 * - Does not overwrite an existing SWIFT_VERSION unless explicitly configured
 */

const fs = require('fs');
const path = require('path');
const xcode = require('xcode');
const childProcess = require('child_process');
const semver = require('semver');
const glob = require('glob');

module.exports = async (context) => {
  const projectRoot = context.opts.projectRoot;

  const shouldRun =
    (context.hook === 'after_platform_add' && context.cmdLine.includes('platform add')) ||
    (context.hook === 'after_prepare' && context.cmdLine.includes('prepare')) ||
    (context.hook === 'after_plugin_add' && context.cmdLine.includes('plugin add'));

  if (!shouldRun) {
    return;
  }

  const platformVersions = await getPlatformVersionsFromFileSystem(context, projectRoot);
  const iosPlatformVersion = platformVersions.find(p => p.platform === 'ios')?.version;

  if (!iosPlatformVersion) {
    return;
  }

  const platformPath = path.join(projectRoot, 'platforms', 'ios');
  const config = getConfigParser(context, path.join(projectRoot, 'config.xml'));

  if (!fs.existsSync(platformPath)) {
    console.log('[swift-support] iOS platform path not found, skipping.');
    return;
  }

  const xcodeprojDir = fs.readdirSync(platformPath).find(name => name.endsWith('.xcodeproj'));
  if (!xcodeprojDir) {
    throw new Error(`[swift-support] No .xcodeproj found in ${platformPath}`);
  }

  const nativeProjectName = path.basename(xcodeprojDir, '.xcodeproj');
  const projectPath = path.join(platformPath, nativeProjectName);
  const pbxprojPath = path.join(platformPath, xcodeprojDir, 'project.pbxproj');
  const pluginsPath = path.join(projectPath, 'Plugins');

  if (!fs.existsSync(pbxprojPath)) {
    throw new Error(`[swift-support] project.pbxproj not found at ${pbxprojPath}`);
  }

  const xcodeProject = xcode.project(pbxprojPath);
  xcodeProject.parseSync();

  const bridgingHeaderPath = getBridgingHeaderPath(projectPath, iosPlatformVersion);
  ensureBridgingHeaderExists(xcodeProject, bridgingHeaderPath);

  const buildConfigs = xcodeProject.pbxXCBuildConfigurationSection();
  const COMMENT_KEY = /_comment$/;
  const bridgingHeaderProperty = `"$(PROJECT_DIR)/$(PROJECT_NAME)${bridgingHeaderPath.split(projectPath)[1]}"`;

  updateBuildConfigs(buildConfigs, COMMENT_KEY, (buildConfig) => {
    const configName = buildConfig.name;

    if (xcodeProject.getBuildProperty('SWIFT_OBJC_BRIDGING_HEADER', configName) !== bridgingHeaderProperty) {
      xcodeProject.updateBuildProperty('SWIFT_OBJC_BRIDGING_HEADER', bridgingHeaderProperty, configName);
      console.log('[swift-support] Set SWIFT_OBJC_BRIDGING_HEADER =', bridgingHeaderProperty, 'for', configName);
    }

    if (xcodeProject.getBuildProperty('ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES', configName) !== 'YES') {
      xcodeProject.updateBuildProperty('ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES', 'YES', configName);
      console.log('[swift-support] Set ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES = YES for', configName);
    }

    const runpath = xcodeProject.getBuildProperty('LD_RUNPATH_SEARCH_PATHS', configName);
    if (runpath !== '"@executable_path/Frameworks"') {
      xcodeProject.updateBuildProperty('LD_RUNPATH_SEARCH_PATHS', '"@executable_path/Frameworks"', configName);
      console.log('[swift-support] Set LD_RUNPATH_SEARCH_PATHS = "@executable_path/Frameworks" for', configName);
    }

    const configuredSwiftVersion =
      config.getPreference('UseSwiftLanguageVersion', 'ios') ||
      config.getPreference('UseLegacySwiftLanguageVersion', 'ios');

    if (configuredSwiftVersion) {
      const currentSwiftVersion = xcodeProject.getBuildProperty('SWIFT_VERSION', configName);
      if (currentSwiftVersion !== configuredSwiftVersion) {
        xcodeProject.updateBuildProperty('SWIFT_VERSION', configuredSwiftVersion, configName);
        console.log('[swift-support] Set SWIFT_VERSION =', configuredSwiftVersion, 'for', configName);
      }
    }

    if (configName === 'Debug') {
      const currentOptimization = xcodeProject.getBuildProperty('SWIFT_OPTIMIZATION_LEVEL', configName);
      if (currentOptimization !== '"-Onone"') {
        xcodeProject.updateBuildProperty('SWIFT_OPTIMIZATION_LEVEL', '"-Onone"', configName);
        console.log('[swift-support] Set SWIFT_OPTIMIZATION_LEVEL = "-Onone" for', configName);
      }
    }
  });

  mergePluginBridgingHeaders(pluginsPath, bridgingHeaderPath);

  fs.writeFileSync(pbxprojPath, xcodeProject.writeSync(), 'utf-8');
};

function updateBuildConfigs(buildConfigs, commentKeyRegex, callback) {
  for (const configName in buildConfigs) {
    if (!commentKeyRegex.test(configName)) {
      callback(buildConfigs[configName]);
    }
  }
}

function ensureBridgingHeaderExists(xcodeProject, bridgingHeaderPath) {
  if (!fs.existsSync(bridgingHeaderPath)) {
    fs.mkdirSync(path.dirname(bridgingHeaderPath), { recursive: true });

    const content = [
      '//',
      '//  Use this file to import your target\'s public headers that you would like to expose to Swift.',
      '//',
      '#import <Cordova/CDV.h>',
      ''
    ].join('\n');

    fs.writeFileSync(bridgingHeaderPath, content, { encoding: 'utf-8', flag: 'w' });

    try {
      xcodeProject.addHeaderFile(path.basename(bridgingHeaderPath));
    } catch (_) {
      // Non-fatal; some project layouts do not require this to succeed.
    }

    console.log('[swift-support] Created bridging header at', bridgingHeaderPath);
  } else {
    let content = fs.readFileSync(bridgingHeaderPath, 'utf-8');
    if (!content.includes('#import <Cordova/CDV.h>')) {
      if (content.length && !content.endsWith('\n')) {
        content += '\n';
      }
      content += '#import <Cordova/CDV.h>\n';
      fs.writeFileSync(bridgingHeaderPath, content, 'utf-8');
      console.log('[swift-support] Added #import <Cordova/CDV.h> to existing bridging header');
    }
  }
}

function mergePluginBridgingHeaders(pluginsPath, bridgingHeaderPath) {
  if (!fs.existsSync(pluginsPath)) {
    return;
  }

  const bridgingHeader = path.basename(bridgingHeaderPath);

  glob('**/*Bridging-Header*.h', { cwd: pluginsPath }, (error, files) => {
    if (error) {
      throw new Error(error);
    }

    const headers = files.map(filePath => path.basename(filePath));
    let content = fs.readFileSync(bridgingHeaderPath, 'utf-8');

    headers.forEach((header) => {
      if (header !== bridgingHeader && !content.includes(header)) {
        if (content.length && !content.endsWith('\n')) {
          content += '\n';
        }
        content += `#import "${header}"\n`;
        console.log('[swift-support] Importing', header, 'into', bridgingHeaderPath);
      }
    });

    fs.writeFileSync(bridgingHeaderPath, content, 'utf-8');
  });
}

function getConfigParser(context, configPath) {
  let ConfigParser;

  if (semver.lt(context.opts.cordova.version, '5.4.0')) {
    ConfigParser = context.requireCordovaModule('cordova-lib/src/ConfigParser/ConfigParser');
  } else {
    ConfigParser = context.requireCordovaModule('cordova-common/src/ConfigParser/ConfigParser');
  }

  return new ConfigParser(configPath);
}

function getBridgingHeaderPath(projectPath, iosPlatformVersion) {
  if (semver.lt(iosPlatformVersion, '4.0.0')) {
    return path.posix.join(projectPath, 'Plugins', 'Bridging-Header.h');
  }

  return path.posix.join(projectPath, 'Bridging-Header.h');
}

function getPlatformVersionsFromFileSystem(context, projectRoot) {
  const cordovaUtil = context.requireCordovaModule('cordova-lib/src/cordova/util');
  const platformsOnFs = cordovaUtil.listPlatforms(projectRoot);

  const platformVersions = platformsOnFs.map(platform => {
    const script = path.join(projectRoot, 'platforms', platform, 'cordova', 'version');

    return new Promise((resolve, reject) => {
      childProcess.exec(`"${script}"`, {}, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    }).then(
      result => ({ platform, version: result.replace(/\r?\n|\r/g, '') }),
      (error) => {
        console.log(error);
        process.exit(1);
      }
    );
  });

  return Promise.all(platformVersions);
}
