const 
crypto = require('crypto'),
config = require('./config'),
NodeCache = require( "node-cache" ),
rp = require('request-promise');

var mycache = new NodeCache();


//steps 1,2,3
module.exports.home = async (req,res,next)=>{    

  let token = req.session.token;
  if(token){
    try{

      let paths = await getLinksAsync(token); 

      if(paths.length>0){
        res.render('gallery', { imgs: paths, layout:false});
      }else{
        //if no images, ask user to upload some
        res.render('empty', {layout:false});
      }    

    }catch(error){
      console.error(error);
      return next(new Error("Error getting images from Dropbox"));
    }

  }else{
    res.redirect('/login');
  }
}



//steps 4,5,6
module.exports.login = (req,res,next)=>{

  //create a random state value
  let state = crypto.randomBytes(16).toString('hex');

  //Save state and temporarysession for 10 mins
  // mycache.set(state, "aTempSessionValue", 600);

  mycache.set(state, req.sessionID, 600);

  let dbxRedirect= config.DBX_OAUTH_DOMAIN 
  + config.DBX_OAUTH_PATH 
  + "?response_type=code&client_id="+config.DBX_APP_KEY
  + "&redirect_uri="+config.OAUTH_REDIRECT_URL 
  + "&state="+state;
  
  res.redirect(dbxRedirect);
}


//steps 8-12
module.exports.oauthredirect = async (req,res,next)=>{

	if(req.query.error_description){
		return next( new Error(req.query.error_description));
	} 

	let state= req.query.state;


	//if(!mycache.get(state)){
	if(mycache.get(state)!=req.sessionID){
		return next(new Error("session expired or invalid state"));
	} 

  //Exchange code for token
  if(req.query.code ){

  	let options={
  		url: config.DBX_API_DOMAIN + config.DBX_TOKEN_PATH, 
      //build query string
      qs: {'code': req.query.code, 
      'grant_type': 'authorization_code', 
      'client_id': config.DBX_APP_KEY, 
      'client_secret':config.DBX_APP_SECRET,
      'redirect_uri':config.OAUTH_REDIRECT_URL}, 
      method: 'POST',
      json: true 
    }

    try{

    	let response = await rp(options);

      //we will replace later cache with a proper storage
			//mycache.set("aTempTokenKey", response.access_token, 3600);
			await regenerateSessionAsync(req);
			req.session.token = response.access_token;

      res.redirect("/");

    }catch(error){
    	return next(new Error('error getting token. '+error.message));
    }        
  }
}


//Returns a promise that fulfills when a new session is created
function regenerateSessionAsync(req){
  return new Promise((resolve,reject)=>{
    req.session.regenerate((err)=>{
      err ? reject(err) : resolve();
    });
  });
}



module.exports.logout = async (req,res,next)=>{
  try{

    await destroySessionAsync(req);
    res.redirect("/login");

  }catch(error){
    return next(new Error('error logging out. '+error.message));
  }  
}

//Returns a promise that fulfills when a session is destroyed
function destroySessionAsync(req){
  return new Promise(async (resolve,reject)=>{

    try{

    //First ensure token gets revoked in Dropbox.com
      let options={
        url: config.DBX_API_DOMAIN + config.DBX_TOKEN_REVOKE_PATH, 
        headers:{"Authorization":"Bearer "+req.session.token},
        method: 'POST'
      }
      let result = await rp(options);

    }catch(error){
      reject(new Error('error destroying token. '));
    }  

    //then destroy the session
    req.session.destroy((err)=>{
      err ? reject(err) : resolve();
    });
  });
}



/*Gets temporary links for a set of files in the root folder of the app
It is a two step process:
1.  Get a list of all the paths of files in the folder
2.  Fetch a temporary link for each file in the folder */
async function getLinksAsync(token){

  //List images from the root of the app folder
  let paths= await listImagePathsAsync(token,'');

  //Get a temporary link for each of those paths returned
  let temporaryLinkResults= await getTemporaryLinksForPathsAsync(token,paths);

  //Construct a new array only with the link field
  var temporaryLinks = temporaryLinkResults.map(function (entry) {
    return entry.link;
  });

  return temporaryLinks;
}


/* Returns an array with the path_lower of each image file */
async function listImagePathsAsync(token,path){
  const imageEntries = await getImagesInFolder(token, path)
  return imageEntries.map(({ path_lower }) => path_lower)
}

async function getImagesInFolder(token, path) {
  const options={
    url: config.DBX_API_DOMAIN + config.DBX_LIST_FOLDER_PATH, 
    headers:{"Authorization":"Bearer "+token},
    method: 'POST',
    json: true ,
    body: {"path":path}
  }
  const result = await rp(options)
  const folderEntries = getFolderEntries(result.entries)
  const nested = await Promise.all(folderEntries.map(({ path_lower }) => {
    return getImagesInFolder(token, path_lower)
  }))

  nested.unshift(getImageEntries(result.entries));
  return nested.reduce((memo, arr) => {
    return [...memo, ...arr]
  }, [])
}


function getFolderEntries(entries) {
  return entries.filter(entry => {
    return entry['.tag'] === 'folder'
  })
}
function getImageEntries(entries) {
  return entries.filter(entry => {
    return entry['.tag'] === 'file' &&
      entry.path_lower.search(/\.(gif|jpg|jpeg|tiff|png)$/i) > -1;
  });
}

//Returns an array with temporary links from an array with file paths
function getTemporaryLinksForPathsAsync(token,paths){

  var promises = [];
  let options={
    url: config.DBX_API_DOMAIN + config.DBX_GET_TEMPORARY_LINK_PATH, 
    headers:{"Authorization":"Bearer "+token},
    method: 'POST',
    json: true
  }

  //Create a promise for each path and push it to an array of promises
  paths.forEach((path_lower)=>{
    options.body = {"path":path_lower};
    promises.push(rp(options));
  });

  //returns a promise that fullfills once all the promises in the array complete or one fails
  return Promise.all(promises);
}
