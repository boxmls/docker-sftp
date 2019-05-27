#!/usr/local/bin/node
/**
 * Need to trigger when a docker "application" is launched and when a user changes their GitHub keys.
 *
 * 1. Get list of running Docker applications, extract the GitHub "id" of each application.
 * 2. Fetch GitHub "collaborators" for each of the application, record them in an object, using only those permissions.push permission.
 * 3. Fetch all public GitHub keys for each "collaborator"
 * 4. Generate /etc/passwd and /etc/ssh/authorized_keys.d/{APP} for each application/user.
 *
 *
 * For local development/testing:
 *    PASSWORDS_PATH=/Users/andy/Documents/GitHub/rabbit-ssh/static/templates/ DIRECTORY_KEYS_BASE=/tmp/authorized_keys.d DEBUG=* node opt/controller.keys.js
 *    
 * For Production on Controller VM:
 *    sudo API_HOSTNAME=api.rabbit.ci DIRECTORY_KEYS_BASE=/etc/ssh/authorized_keys.d PASSWORD_FILE=/etc/passwd PASSWORDS_TEMPLATE=ubuntu.passwords controller.keys
 *
 * To trigger [rabbit-keys-updater.service] to update keys as root.
 *    CONTROLLER_KEYS_PATH=/media/state/ssh/controlller-state.json controller.keys
 *
 * For Production on Kubernetes rabbit-ssh VM:
 *    DIRECTORY_KEYS_BASE=/etc/ssh/authorized_keys.d PASSWORD_FILE=/etc/passwd PASSWORDS_TEMPLATE=alpine.passwords opt/controller.keys.js
 *
 * For Production on Kubernetes rabbit-ssh VM (write to state.json):
 *    CONTROLLER_KEYS_PATH=/var/lib/rabbit-ssh/state.json DIRECTORY_KEYS_BASE=/etc/ssh/authorized_keys.d PASSWORD_FILE=/etc/passwd PASSWORDS_TEMPLATE=alpine.passwords opt/controller.keys.js
 *
 *
 */

var async       = require( 'async' );
var Mustache    = require( 'mustache' );
var request     = require( 'requestretry' );
var fs          = require( 'fs' );
var debug       = require( 'debug' )('update-ssh');
var _           = require( 'lodash' );

module.exports.updateKeys = function updateKeys( options, taskCallback ) {

  taskCallback = 'function' === typeof taskCallback ? taskCallback : function taskCallback() {

    if( process.env.SLACK_NOTIFICACTION_URL ) {
      request({
        method: 'POST',
        url: process.env.SLACK_NOTIFICACTION_URL,
        json: true,
        body: {
          channel: process.env.SLACK_NOTIFICACTION_CHANNEL,
          username: 'Rabbit/SSH',
          text: "SSH Keys refreshed on " + (process.env.HOSTNAME || process.env.HOST) + " has finished. ```kubectl -n rabbit-system exec -it " + (process.env.HOSTNAME || process.env.HOST) + " sh```"
        }
      })
    }

  }

  options = _.defaults(options, {
    statePath: process.env.CONTROLLER_KEYS_PATH || null,
    keysPath: process.env.DIRECTORY_KEYS_BASE || './tmp/authorized_keys.d',
    passwordFile: process.env.PASSWORD_FILE || './tmp/passwd-tmp',
    passwordTemplate: process.env.PASSWORDS_TEMPLATE || 'alpine.passwords',
    passwordPath: process.env.PASSWORDS_PATH || '/opt/sources/rabbitci/rabbit-ssh/static/templates/',
    accessTokens: (process.env.GITHUB_ACCESS_TOKENS || '').split(',')
  });

  if( !options.accessTokens ) {
    return taskCallback( new Error( 'Missing [accessTokens].') );
  }

  // check that target key directory exists
  if( !fs.existsSync( options.keysPath ) ) {
    console.error( "authorized_keys [%s] directory missing.", options.keysPath );
    return;
  }

  if( !options.passwordFile ) {
    console.error( "the PASSWORD_FILE is not explicitly set." );
    return;
  }

  if( !options.passwordTemplate ) {
    console.error( "the PASSWORDS_TEMPLATE is not explicitly set." );
    return;
  }

  var _applications = {};   // application to GitHub users
  var _allKeys = {};        // contains a GitHub User -> Array of Keys
  var _users = {};          // list of all users

  function getAccessToken() {

    return _.sample( _.get( options, 'accessTokens' ) );

  }

  var _container_url = 'http://localhost:' + process.env.NODE_PORT + '/v1/pods';

  request( { url: _container_url, strictSSL: false, headers: { 'x-rabbit-internal-token': process.env.KUBERNETES_CLUSTER_USER_TOKEN }, json: true }, haveContainers );

  /**
   * Have Container List.
   *
   * @param err
   * @param resp
   * @param body
   */
  function haveContainers(err, resp, body) {


//    process.exit();

    if( err || _.size( _.get( body, 'items', [] ) ) === 0 ) {
      console.error( "No response from container lookup at [%s].", _container_url );
      console.error( " -err ", err);
      console.error( " -headers ", resp.headers);
      //body = require('../static/fixtures/pods');
      return false;
    }

    var _containers = body = _.map(body.items, function( singleItem ) {

      singleItem.Labels = _.get( singleItem, 'metadata.labels' );

      singleItem.Labels['ci.rabbit.name']  = singleItem.Labels['name'] ;

      singleItem.Labels['ci.rabbit.ssh.user'] = singleItem.Labels['ci.rabbit.ssh.user'] || null ;
      return singleItem;

    });

    ( _containers || [] ).forEach(function (containerInfo) {

      var _labels = _.get( containerInfo, 'metadata.labels', {} );

      if( !_labels['ci.rabbit.ssh.user'] || null ) {
        return;
      }

      var _ssh_user = _labels['ci.rabbit.ssh.user'];

      if( !_ssh_user ) {
        return;
      }

      // @todo May need to identify non-primary-branch apps here, or use a special label
      _applications[ _ssh_user ] = {
        _id: (_labels['git.owner'] || _labels['git_owner'] ) + '/' + ( _labels['git.name'] || _labels['git_name'] ),
        sshUser: containerInfo.Labels['ci.rabbit.ssh.user'] || null,
        //name: containerInfo.Names[0],
        namespace: _.get( containerInfo, 'metadata.namespace' ),
        users: {},
        containers: []
      };

    });

    _.each( _applications, function addConainers( application ) {

      application.containers = _.map( _.filter( body, { Labels: { 'ci.rabbit.ssh.user':  application.sshUser } }), function( foundContainer ) {
        return {containerName: _.get(foundContainer, 'metadata.name' ) || foundContainer.Labels['ci.rabbit.name']}
      })

    })

    async.eachLimit( _.values( _applications ), 3,  function fetchCollaborators( data, callback ) {
      // console.log( 'fetchCollaborators', data );

      var _token = getAccessToken();

      var requestOptions = {
        url: 'https://api.github.com/repos/' + data._id + '/collaborators',
        json: true,
        headers: {
          'Authorization': 'token ' + _token,
          'User-Agent': 'wpCloud/Controller'
        }
      };

      request( requestOptions, function haveAppCollaborators( error, res, body ) {
        debug( 'haveAppCollaborators [%s] using [%s] got code [%s]', requestOptions.url, _token, _.get( res, 'statusCode' ) );

        if( _.get( res, 'headers.x-ratelimit-remaining') === '0' ) {
          console.error( "GitHub ratelimit exceeded using [%s] token.", requestOptions.headers.Authorization );
        }

        // get just the permissions, add users to application
        ( 'object' === typeof body && body.length > 0 ? body : [] ).forEach(function( thisUser ) {

          _applications[ data.sshUser ].users[ thisUser.login ] = {
            _id: thisUser.login,
            permissions: thisUser.permissions
          };
          _users[ thisUser.login ] = _users[ thisUser.login ] || [];
          _users[ thisUser.login ].push( data._id );
        });

        callback();

      });

    }, haveCollaborators)

  }

  /**
   * Callback for when all collaborators have been collected from all the apps.
   *
   */
  function haveCollaborators() {
    console.log( 'haveCollaborators. Have [%d].', Object.keys( _users ).length );

    _.each(_users, function eachCollaborator( collaboratorName ) {
      //console.log( arguments );
    });

    getCollaboratorsKeys(haveAllKeys, _users)
  }

  /**
   * Fetch GitHub keys for a specific user from GitHub
   */
  function getCollaboratorsKeys( done, users ) {
    debug( 'getCollaboratorsKeys' );

    async.each( _.keys( users ) , function iterator(userName, singleComplete) {

      /**
       *
       * @todo Check that response is valid, not an error due to invalid user or whatever
       *
       * @param error
       * @param resp
       * @param body
       */
      function gitHubCallback( error, resp, body ) {
        debug( 'gitHubCallback', userName );

        var _userKeys = body.split( "\n" );

        _allKeys[ userName ] = cleanArray( _userKeys );

        singleComplete( null );

      }

      request({
        method: 'get',
        url: 'https://github.com/' +  userName +'.keys'
      }, gitHubCallback);

    }, function allDone() {
      debug( 'getCollaboratorsKeys:allDone' );

      done( null, _allKeys );

    });

  }

  /**
   * Callback triggered when all the GitHub user keys are fetched
   * @param error
   * @param _allKeys
   */
  function haveAllKeys( error, _allKeys ) {
    debug( 'haveAllKeys [%d]', Object.keys( _allKeys ).length );

    //
    if( options.statePath && _allKeys ) {
      fs.writeFileSync(options.statePath, JSON.stringify({keys:_allKeys}, null, 2), 'utf8');
      return taskCallback(null, {ok: true, statePath: options.statePath })
    }

    // create /etc/ssh/authorized_keys.d/{APP} directories
    _.keys( _applications ).forEach( function createDirectory( appID ) {

      if( !_applications[ appID ].sshUser ) {
        console.log( "Skipping [%s] because it does not have the 'ci.rabbit.ssh.user' label.",  appID );
        return;
      }

      var _path =  ( options.keysPath ) + '/' + _applications[ appID ].sshUser;

      var writableKeys = [];

      debug( 'Creating SSH keys file for [%s] at [%s]/', appID, _path );

      _.values( _applications[ appID ].users ).forEach(function( userData ) {

        var _envs = {
          application: appID,
          namespace: _applications[appID].namespace,
          containerName: _.get( _applications[appID] , 'containers[0].containerName' ),
          user_data:userData._id,
          CONNECTION_STRING: [ '-n', _applications[appID].namespace, ' ', _.get( _applications[appID] , 'containers[0].containerName' ) ].join(' ')
        }

        _.get( _allKeys, userData._id, [] ).forEach(function( thisUsersKey ) {
          writableKeys.push( 'environment="CONNECTION_STRING='+_envs.CONNECTION_STRING + '"   ' + thisUsersKey);
          //writableKeys.push( 'environment="CONNECTION_STRING=-n '+_envs.namespace+' ' + _envs.containerName + ' ');
        })

      });

      if(writableKeys.length > 0){
        // console.log('appID', require('util').inspect(_applications[ appID ], {showHidden: false, depth: 10, colors: true}));

        fs.writeFile(_path, writableKeys.join("\n"), function(err) {

          if(err) {
            return console.log(err);
          }

          debug( "Wrote SSH Key file for [%s] identified as [%s] user.",  appID, _applications[ appID ].sshUser );
          // console.log("The file was saved!");

        });

      } else {
        console.error( "No keys returned [%s] not updated.", _path )
      }

      _.each(_applications[appID].containers, function( singleContainer ) {

        var _container_path = ( options.keysPath  ) + '/' + _.get( singleContainer, 'containerName' );

        if(writableKeys.length > 0){
          fs.writeFile(_container_path, writableKeys.join("\n"), function(err) {

            if(err) {
              return console.log(err);
            }

            console.log( "Wrote SSH Key file for [%s] applications contianer [%s].",  appID, _.get( singleContainer, 'containerName' ) );
            // console.log("The file was saved!");

          });

        } else {
          console.error( "No keys returned [%s] not updated.", _container_path )

        }
      })

    });

    var _full_path = ( options.passwordPath ) + '' + ( options.passwordTemplate ) + '.mustache';

    // create /etc/passwd file
    fs.readFile( _full_path, 'utf8', function (err,source) {

      if (err) {
        return console.log(err);
      }

      var userFile = Mustache.render(source, {
        applications: _.values( _applications )
      });

      fs.writeFile( options.passwordFile, userFile, 'utf8', function( error ) {
        console.log( 'Updated [%s] file with [%d] applications.', options.passwordFile, _.size( _applications ) )
        taskCallback(null, {ok: true,applications:_applications,users:_users})
      });


    });

  }

  /**
   * Helper to remove blank values from array.
   * @param actual
   * @returns {Array}
   */
  function cleanArray(actual) {
    var newArray = new Array();
    for (var i = 0; i < actual.length; i++) {
      if (actual[i]) {
        newArray.push(actual[i]);
      }
    }
    return newArray;
  }

}

if( !module.parent ){
  module.exports.updateKeys();
}