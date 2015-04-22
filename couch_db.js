/**
 * 2012 Max 'Azul' Wiehle
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var couch       = require("felix-couchdb");
var async       = require("async");

var handleError = function handleError(er) {
  if (er) throw new Error(er);
};

exports.database = function(settings)
{
  this.db=null;
  this.client=null;
  
  this.settings = settings;
  
  //set default settings
  this.settings.cache = 1000;
  this.settings.writeInterval = 100;
  this.settings.json = false;
}

// Always ensure that couchDb has at least an empty design doc for UeberDb use
// this will be necessary for the `findKeys` method
var checkUeberDbDesignDocument = function checkUeberDbDesignDocument() 
{
  var db = this.db;
  db.getDoc('_design/ueberDb', function (er, doc) {
    if (er && er.error === 'not_found') {
      return db.saveDesign('ueberDb', {views: {}}, handleError)
    };
    if (er) throw new Error(er);
  });
};

exports.database.prototype.init = function(callback)
{
  this.client = couch.createClient(this.settings.port, this.settings.host, this.settings.user, this.settings.password, this.settings.maxListeners);
  this.db = this.client.db(this.settings.database);
  checkUeberDbDesignDocument.call(this);
  callback();
}

exports.database.prototype.get = function (key, callback)
{
  this.db.getDoc(key, function(er, doc)
  {
    if(doc == null)
    {
      callback(null, null);
    }
    else
    {
      callback(null, doc.value);
    }
  });
}

exports.database.prototype.findKeys = function (key, notKey, callback)
{
  var regex     = this.createFindRegex(key, notKey);
  var queryKey  = key + '__' + notKey;
  var db        = this.db;
  
  // always look up if the query haven't be done before
  var checkQuery = function checkQuery(er, doc) { 
    handleError(er);
    var queryExists = queryKey in doc.views;
    if (!queryExists) return createQuery(doc);
    makeQuery();
  };

  // Cache the query for faster reuse in the future
  var createQuery = function createQuery(doc) {
    var mapFunction     = {
      map: 'function(doc) {' +
        'if (' + regex + '.test(doc._id)) {' +
          'emit(doc._id, null);' +
        '}' +
      '}',
    }
    doc.views[queryKey] = mapFunction;
    db.saveDesign('ueberDb', doc, function (er) {
      handleError(er);
      makeQuery();
    })
  };

  // If this is the first time the request is used, this can take a while…
  var makeQuery = function makeQuery(er) {
    db.view('ueberDb', queryKey, function (er, docs) {
      handleError(er);
      docs = docs.rows.map(function (doc) { return doc.key; });
      callback(null, docs);  
    });
  };

  db.getDoc('_design/ueberDb', checkQuery);
}

exports.database.prototype.set = function (key, value, callback)
{
  var _this = this;
  this.db.getDoc(key, function(er, doc)
  {
    if(doc == null)
    {
      _this.db.saveDoc({_id: key, value: value}, callback);
    }
    else
    {
      _this.db.saveDoc({_id: key, _rev: doc._rev, value: value}, callback);
    }
  });
}

exports.database.prototype.remove = function (key, callback)
{
  var _this = this;
  this.db.getDoc(key, function(er, doc)
  {
    if(doc == null)
    {
      callback(null);
    }
    else
    {
      _this.db.removeDoc(key, doc._rev, function(er,r)
      {
        callback(null);
      });
    }
  });
}

exports.database.prototype.doBulk = function (bulk, callback)
{
  var _this = this;
  var keys = [];
  var revs = {};
  var setters = [];
  for(var i in bulk)
  {
    keys.push(bulk[i].key);
  }
  async.series([
    function(callback)
    {
      _this.db.request({
        method: 'POST',
        path: '/_all_docs',
        data: {keys: keys},
      }, function(er, r)
      {
        if (er) throw new Error(JSON.stringify(er));
        rows = r.rows;
        for(var j in r.rows)
        {
          // couchDB will return error instead of value if key does not exist
          if(rows[j].value!=null)
          {
            revs[rows[j].key] = rows[j].value.rev;
          }
        }
        callback();
      });
    },
    function(callback)
    {
      for(var i in bulk)
      {
        var item = bulk[i];
        var set = {_id: item.key};
        if(revs[item.key] != null)
        {
          set._rev = revs[item.key];
        }
        if(item.type == "set")
        {
          set.value = item.value;
          setters.push(set);
        }
        else if(item.type == "remove")
        {
          set._deleted = true;
          setters.push(set);
        }
      }
      callback();
    }], function(err) {
      _this.db.bulkDocs({docs: setters}, callback);
    }
  );
}

exports.database.prototype.close = function(callback)
{
  if(callback) callback();
}
