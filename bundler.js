var _ = require('lodash');
var path = require('path');
var jspm = require('jspm');
var async = require('async');
var mkdirp = require('mkdirp');
var chksum = require('checksum');
var Builder = require('jspm').Builder;
var root = path.dirname(require.main.filename) + '/';

module.exports = JSPMBundler;

function JSPMBundler(opts) {

    var _this = this;

    var _bundles = {};

    var _system = {
        baseURL: _getJSPMBaseURL(),
        config: _getSystemJSConfig()
    };

    var _opts = _.defaults(opts || {}, {
        bundleDest: 'bundles/',
        bundleFile: 'bundles.js',
        builder: {
            minify: false,
            mangle: false,
            sourceMaps: false,
        }
    });

    /**
     * Set the bundle configuration map.
     *
     * @param {Object} bundleConfig
     * @returns {JSPMBundler}
     */
    this.bundles = function(bundleConfig) {
        _bundles = bundleConfig;
        return _this;
    }

    /**
     * Create bundles using the bundle configuration. If no bundles are
     * specified, all groups will be bundles.
     *
     * Example:
     * bundler.bundle(['app', 'routes']);
     *
     * @param {Array} groups
     * @returns {Promise}
     */
    this.bundle = function(groups) {

        if (_.isEmpty(_bundles)) {
            throw new Error('Cant bundle until bundles are defined');
        }

        console.log('-- Bundling -------------');

        var promises = [];
        var completed = [];
        groups = (groups) ? groups : _.keys(_bundles);
        groups = (_.isArray(groups)) ? groups : [groups];

        _.forEach(groups, function (groupName) {
            promises.push(async.asyncify(function(){
                return _bundleGroup(groupName).then(function(bundles){
                    completed = completed.concat(bundles);
                });
            }));
        });

        return new Promise(function(resolve){
            async.series(promises, resolve);
        }).then(function(){
            return _calcChecksums(completed).then(function(checksums){
                _updateBundleManifest(completed, checksums);
                console.log('-- Complete -------------');
            });
        });
    }

    /**
     *
     * @param {Array} groups
     */
    this.unbundle = function(groups) {

        console.log('-- Unbundling -----------');

        if (!groups) {
            console.log('Removing all bundles...');
            _writeBundleManifest(null);
            return;
        }

        groups = (groups) ? groups : _.keys(_bundles);
        groups = (_.isArray(groups)) ? groups : [groups];

        var unbundles = [];
        var shortPath = '';

        _.forEach(groups, function(groupName){

            var bundleOpts = _getBundleOpts(groupName);

            if (bundleOpts.combine) {

                shortPath = _getBundleShortPath(groupName, bundleOpts);
                unbundles.push({path: shortPath});
                console.log(' ✔ Removed:', shortPath);

            } else {

                _.forEach(bundleOpts.items, function(item) {
                    shortPath = _getBundleShortPath(item, bundleOpts);
                    unbundles.push({path: shortPath});
                    console.log(' ✔ Removed:', shortPath);
                });

            }

        });

        _removeFromBundleManifest(unbundles);

    }


    /**
     * Build the options object for a bundle
     *
     * @param {String} name
     * @returns {Object} options
     * @private
     */
    function _getBundleOpts(name) {
        var opts = _bundles[name];
        if (opts) {
            opts.builder = _.defaults(opts.builder, _opts.builder);
            return opts;
        } else {
            return false;
        }
    }

    /**
     * Build the destination path for a bundle
     *
     * @param {String} bundleName
     * @param {Object} bundleOpts
     * @returns {string}
     * @private
     */
    function _getBundleDest(bundleName, bundleOpts) {
        var url = _system.baseURL + opts.bundleDest;
        var min = bundleOpts.builder.minify;
        var file = bundleName + ((min) ? '.min.js' : '.js');

        if (bundleOpts.combine) {
            url = path.join(url, bundleName, file);
        } else {
            url = path.join(url, file);
        }
        return url;
    }

    /**
     *
     * @param bundleName
     * @param bundleOpts
     * @returns {string}
     * @private
     */
    function _getBundleShortPath(bundleName, bundleOpts) {
        var fullPath = _getBundleDest(bundleName, bundleOpts);
        return fullPath.replace(_getJSPMBaseURL(), '');

    }

    /**
     *
     * @param {String} name
     * @returns {Promise}
     * @private
     */
    function _bundleGroup(name) {

        var bundleOpts = _getBundleOpts(name);

        if (!bundleOpts) {

            return Promise.reject('Unable to find group: ' + name);

        } else if (bundleOpts.bundle === false) {

            return Promise.resolve('Skipping: ' + name);

        }

        console.log('Bundling group:', name, '...');

        var promises = [];
        var completed = [];
        var bundleItems, minusStr;
        var bundleStr, bundleDest;

        bundleStr = '';
        bundleItems = bundleOpts.items || [];
        bundleItems = (_.isArray(bundleItems)) ? bundleItems : _.keys(bundleItems);
        minusStr = _exclusionString(bundleOpts.exclude, _bundles);

        if (bundleOpts.combine) {

            // Combine all the items in the group and bundle together.

            bundleDest = _getBundleDest(name, bundleOpts);
            bundleStr = bundleItems.join(' + ') + minusStr;
            promises.push(async.asyncify(function() {
                return _bundle(bundleStr, bundleDest, bundleOpts).then(function(bundle){
                    console.log(' ✔ Bundled:', name);
                    completed.push(bundle);
                    return bundle;
                });
            }));

        } else {

            // Bundle each of the items in the group individually.

            _.forEach(bundleItems, function (itemName) {

                promises.push(async.asyncify(function() {

                    bundleStr = itemName + minusStr;
                    bundleDest = _getBundleDest(itemName, bundleOpts);

                    return _bundle(bundleStr, bundleDest, bundleOpts).then(function(bundle){
                        console.log(' ✔ Bundled:', itemName);
                        completed.push(bundle);
                        return bundle;
                    });
                }));
            });
        }

        return new Promise(function(resolve) {
            async.series(promises, function() {
                resolve(completed);
            });
        });
    };


    /**
     *
     * @param bundleStr
     * @param bundleDest
     * @param bundleOpts
     * @returns {Promise}
     * @private
     */
    function _bundle(bundleStr, bundleDest, bundleOpts) {

        var builder = new Builder({separateCSS: false});
        var shortPath = bundleDest.replace(_system.baseURL, '');
        var builderOpts = bundleOpts.builder;

        mkdirp.sync(path.dirname(bundleDest));

        return new Promise(function(resolve) {
            builder.bundle(bundleStr, bundleDest, builderOpts).catch(function (err) {
                console.log('Build Error', err);
                resolve(err);
            }).then(function(output){
                resolve({
                    path: shortPath,
                    modules: output.modules
                });
            });
        });
    }


    /**
     *
     * @returns {String}
     * @private
     */
    function _getBundleManifestPath() {
        var url = _getJSPMBaseURL();
        return String(path.join(url, _opts.bundleFile));
    }

    /**
     *
     * @returns {Object}
     * @private
     */
    function _getBundleManifest() {
        var data, path = _getBundleManifestPath();
        try { data = require(path); } catch(e) { console.log(e); data = {}; }
        return data;
    }


    /**
     *
     * @param bundles
     * @private
     */
    function _updateBundleManifest(bundles, chksums) {

        chksums = chksums || {};

        var manifest = _.defaults(_getBundleManifest() || {}, {
            bundles: {},
            chksums: {}
        });

        _.forEach(bundles, function(bundle) {
            if (bundle.path) {
                manifest.bundles[bundle.path] = bundle.modules;
                manifest.chksums[bundle.path] = chksums[bundle.path] || '';
            }
        });

        _writeBundleManifest(manifest);

    }

    /**
     *
     * @param bundles
     * @private
     */
    function _removeFromBundleManifest(bundles) {

        var manifest = _.defaults(_getBundleManifest() || {}, {
            bundles: {},
            chksums: {}
        });

        _.forEach(bundles, function(bundle) {
            delete manifest.bundles[bundle.path];
            delete manifest.chksums[bundle.path];
        });

        _writeBundleManifest(manifest);

    }

    /**
     *
     * @param manifest
     * @private
     */
    function _writeBundleManifest(manifest) {

        console.log('Updating manifest...');

        var fs = require('fs');
        var output = '';

        if (!manifest) {
            manifest = {
                bundles: {},
                chksums: {}
            };
        }

        output += '(function(module){\n';
        output += '  var chksums = module.exports.chksums = ' + JSON.stringify(manifest.chksums, null, '\t') + ';\n';
        output += '  var bundles = module.exports.bundles = ' + JSON.stringify(manifest.bundles, null, '\t') + ';\n';
        output += '  System.config({bundles: bundles});\n';
        output += '})((typeof module !== "undefined") ? module : {exports: {}});';

        fs.writeFileSync(_getBundleManifestPath(), output);

        console.log(' ✔ Manifest updated');

    }




    /**
     *
     * @param {Object} bundles
     * @returns {Promise}
     * @private
     */
    function _calcChecksums(bundles) {

        var chksums = {};
        var promises = [];
        var filepath, filename;

        console.log('Calculating checksums...');

        _.forEach(bundles, function(bundle){

            if (!_.isObject(bundle)) { return; }

            promises.push(async.asyncify(function() {
                return new Promise(function(resolve){
                    filepath = path.join(_getJSPMBaseURL(), bundle.path);
                    filename = path.parse(bundle.path).base;
                    chksum.file(filepath, function(err, sum){
                        if (err) { console.log(' Error:', err); }
                        console.log(' ✔', filename, sum);
                        chksums[bundle.path] = sum;
                        resolve(sum);
                    });
                });
            }));
        });

        return new Promise(function(resolve) {
            async.waterfall(promises, function() {
                resolve(chksums);
            });
        });
    }

}


/**
 * Load JSPM and the user's config.js to get the map
 * @returns {System.config}
 * @private
 */
function _getSystemJSConfig() {
    var jspm = require('jspm');
    var url = _getJSPMBaseURL();
    var file = url + 'config.js';
    require(file);
    return System.config;
}

/**
 *
 * @returns {String}
 * @private
 */
function _getJSPMBaseURL() {
    var pjson = require(root + '/package.json');
    var url = _.get(pjson, 'jspm.directories.baseURL') || '.';
    return root + ((url.substr(-1) == '/') ? url : url + '/');
}



/**
 *
 * @param {Array|Object} exclude
 * @param {Object} groups
 * @returns {String}
 * @private
 */
function _exclusionString(exclude, groups) {
    var str = _exclusionArray(exclude, groups).join(' - ');
    return (str) ? ' - ' + str : '';
}

/**
 *
 * @param {Array|Object} exclude
 * @param {Object} groups
 * @returns {Array}
 * @private
 */
function _exclusionArray(exclude, groups) {
    var minus = [];
    exclude = (_.isArray(exclude)) ? exclude : _.keys(exclude);
    _.forEach(exclude, function (item) {
        var group = groups[item];
        if (group) {
            // exclude everything from this group
            minus = minus.concat(_exclusionArray(group.items, groups));
        } else {
            // exclude this item by name
            minus.push(item);
        }
    });
    return minus;
}