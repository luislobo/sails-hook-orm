/**
 * Module dependencies
 */

var util = require('util');
var _ = require('@sailshq/lodash');
var helpLeaseConnection = require('./help-lease-connection');

/**
 * Lease a transactional database connection, run the provided `during` function,
 * then either commit the transaction or (in the event of an error) roll it back.
 * Finally, release the connection back to the manager from whence it came.
 *
 * > This utility is for a datastore (RDI) method.  Before attempting to use this,
 * > the datastore method should guarantee that the adapter (via its driver) actually
 * > supports all the necessary pieces.
 *
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * @param  {Dictionary} options
 *         @required {Ref} manager
 *         @required {Ref} driver
 *         @required {Function} during
 *                   @param {Ref} db   [The leased (transactional) database connection.]
 *                   @param {Function} proceed
 *                          @param {Error?} err
 *                          @param {Ref?} resultMaybe
 *         @optional {Dictionary} meta
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * @param  {Function} done
 *         @param {Error?} err
 *         @param {Ref?} resultMaybe
 *                If defined, this is the result sent back from the provided
 *                `during` function.
 */
module.exports = function helpRunTransaction(options, done){


  helpLeaseConnection({
    manager: options.manager,
    driver: options.driver,
    meta: options.meta,
    during: function (db, proceed){

      //  ╔╗ ╔═╗╔═╗╦╔╗╔  ┌┬┐┬─┐┌─┐┌┐┌┌─┐┌─┐┌─┐┌┬┐┬┌─┐┌┐┌
      //  ╠╩╗║╣ ║ ╦║║║║   │ ├┬┘├─┤│││└─┐├─┤│   │ ││ ││││
      //  ╚═╝╚═╝╚═╝╩╝╚╝   ┴ ┴└─┴ ┴┘└┘└─┘┴ ┴└─┘ ┴ ┴└─┘┘└┘
      options.driver.beginTransaction({
        connection: db,
        meta: options.meta
      }, function (err, report){
        if (err) { return proceed(err); }


        //  ╦═╗╦ ╦╔╗╔  ┌┬┐┬ ┬┌─┐  \│/┌┬┐┬ ┬┬─┐┬┌┐┌┌─┐\│/  ┌─┐┬ ┬┌┐┌┌─┐┌┬┐┬┌─┐┌┐┌
        //  ╠╦╝║ ║║║║   │ ├─┤├┤   ─ ─ │││ │├┬┘│││││ ┬─ ─  ├┤ │ │││││   │ ││ ││││
        //  ╩╚═╚═╝╝╚╝   ┴ ┴ ┴└─┘  /│\─┴┘└─┘┴└─┴┘└┘└─┘/│\  └  └─┘┘└┘└─┘ ┴ ┴└─┘┘└┘
        // Invoke a self-calling function that calls the provided `during` function.
        (function _makeCallToDuringFn(proceed){

          // Note that, if you try to call the callback more than once in the iteratee,
          // this method logs a warning explaining what's up, ignoring any subsequent calls
          // to the callback that occur after the first one.
          var didDuringFnAlreadyHalt;
          try {
            options.during(db, function (err, resultMaybe) {
              if (err) { return proceed(err); }

              if (didDuringFnAlreadyHalt) {
                console.warn(
                  'Warning: The `during` function provided to `.transaction()` triggered its callback \n'+
                  'again-- after already triggering it once!  Please carefully check your `during` function\'s \n'+
                  'code to figure out why this is happening.  (Ignoring this subsequent invocation...)'
                );
                return;
              }//-•

              didDuringFnAlreadyHalt = true;

              return proceed(undefined, resultMaybe);

            });//</ invoked `during` >
          } catch (e) { return proceed(e); }

        })(function _afterCallingDuringFn(duringErr, resultMaybe){

          //  ╦ ╦╔═╗╔╗╔╔╦╗╦  ╔═╗  ┌─┐┬─┐┬─┐┌─┐┬─┐  ┌─┐┬─┐┌─┐┌┬┐  \│/┌┬┐┬ ┬┬─┐┬┌┐┌┌─┐\│/
          //  ╠═╣╠═╣║║║ ║║║  ║╣   ├┤ ├┬┘├┬┘│ │├┬┘  ├┤ ├┬┘│ ││││  ─ ─ │││ │├┬┘│││││ ┬─ ─
          //  ╩ ╩╩ ╩╝╚╝═╩╝╩═╝╚═╝  └─┘┴└─┴└─└─┘┴└─  └  ┴└─└─┘┴ ┴  /│\─┴┘└─┘┴└─┴┘└┘└─┘/│\
          //   ┬   ╦═╗╔═╗╦  ╦  ╔╗ ╔═╗╔═╗╦╔═
          //  ┌┼─  ╠╦╝║ ║║  ║  ╠╩╗╠═╣║  ╠╩╗
          //  └┘   ╩╚═╚═╝╩═╝╩═╝╚═╝╩ ╩╚═╝╩ ╩
          // If an error occured while running the duringFn, automatically rollback
          // the transaction.
          if (duringErr) {

            // Since this `duringErr` came from the userland `during` fn, we can't
            // completely trust it.  So check it out, and if it's not one already,
            // convert `duringErr` into Error instance.
            if (!_.isError(duringErr)) {
              if (_.isString(duringErr)) {
                duringErr = new Error(duringErr);
              }
              else {
                duringErr = new Error(util.inspect(duringErr, {depth:5}));
              }
            }//>-

            options.driver.rollbackTransaction({ connection: db, meta: options.meta }, {
              error: function(secondaryErr) {
                return proceed(new Error(
                  'First, encountered error:\n'+
                  '```\n'+
                  duringErr.stack +'\n'+
                  '```\n'+
                  '...AND THEN when attempting to roll back the database transaction, there was a secondary error:\n'+
                  '```\n'+
                  secondaryErr.stack+'\n'+
                  '```'
                ));
              },
              success: function (){
                // Otherwise, the rollback was successful-- so proceed with the
                // original error (this will release the connection).
                return proceed(duringErr);
              }
            });//_∏_ </driver.rollbackTransaction()>
            return;
          }//--•


          //  ┌─┐┌┬┐┬ ┬┌─┐┬─┐┬ ┬┬┌─┐┌─┐  ╦ ╦╔═╗╔╗╔╔╦╗╦  ╔═╗  ┌─┐┬ ┬┌─┐┌─┐┌─┐┌─┐┌─┐
          //  │ │ │ ├─┤├┤ ├┬┘││││└─┐├┤   ╠═╣╠═╣║║║ ║║║  ║╣   └─┐│ ││  │  ├┤ └─┐└─┐
          //  └─┘ ┴ ┴ ┴└─┘┴└─└┴┘┴└─┘└─┘  ╩ ╩╩ ╩╝╚╝═╩╝╩═╝╚═╝  └─┘└─┘└─┘└─┘└─┘└─┘└─┘
          //   ┬   ╔═╗╔═╗╔╦╗╔╦╗╦╔╦╗  ┌┬┐┬─┐┌─┐┌┐┌┌─┐┌─┐┌─┐┌┬┐┬┌─┐┌┐┌
          //  ┌┼─  ║  ║ ║║║║║║║║ ║    │ ├┬┘├─┤│││└─┐├─┤│   │ ││ ││││
          //  └┘   ╚═╝╚═╝╩ ╩╩ ╩╩ ╩    ┴ ┴└─┴ ┴┘└┘└─┘┴ ┴└─┘ ┴ ┴└─┘┘└┘
          // IWMIH, then the `during` function ran successfully.
          options.driver.commitTransaction({ connection: db, meta: options.meta }, {
            error: function(secondaryErr) {
              // Proceed to release the connection, and send back an error.
              // (Since the transaction could not be committed, this effectively failed.)
              return proceed(new Error(
                'The `during` function ran successfully, but there was an issue '+
                'commiting the db transaction:\n'+
                '```\n' +
                secondaryErr.stack+'\n'+
                '```'
              ));
            },
            success: function(){
              // Proceed to release the connection, sending back the result
              // (only relevant if the provided `during` function sent one back).
              return proceed(undefined, resultMaybe);
            }
          });//</callback from driver.commitTransaction()>
        });//</callback from self-calling function that ran the provided `during` fn>
      });//</callback from driver.beginTransaction()>
    }//</argins for helpLeaseConnection()>
  }, function (err, resultMaybe) {
    if (err) { return done(err); }
    return done(undefined, resultMaybe);
  });//</callback from helpLeaseConnection()>

};


// To test:
// ```
// User.getDatastore().transaction(function(db, proceed){  async.map(require('lodash').range(10), function (i, next){  var rand = Math.floor(Math.random()*10);  User.findOrCreate({luckyNumber: rand}, {luckyNumber: rand }).usingConnection(db).meta({fetch: true}).exec(next); }, proceed);  }).exec(function _afterwards(){if (arguments[0]) { console.log('ERROR:', arguments[0]); return; } console.log('Ok.  Result:',arguments[1]);  });
// ```
//^^^ should result in an error-- and when examining the state of the database afterwards,
//    nothing should have been created.  (Contrast this behavior with the same code, but
//    replacing "transaction" with "leaseConnection".  Without the transaction, some records
//    would be created, but the transaction prevents this from happening)