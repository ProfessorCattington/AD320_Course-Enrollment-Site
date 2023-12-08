'use strict';
const express = require('express');

const app = express();
const cors = require('cors');
const sqlite3 = require('sqlite3');
const sqlite = require('sqlite');
const multer = require('multer');
const cookieParser = require('cookie-parser');

const PORT = 8000

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(multer().none());
app.use(cookieParser());


//ERRORS
const USER_ERROR = 400;
const USER_ERROR_ENDPOINT_MSG = "Invalid endpoint or parameters."
const USER_ERROR_NO_USER_MSG = "No userID or password for that entry."
const SERVER_ERROR = 500;
const SERVER_ERROR_MSG = "Unable to retrieve from the database:"
const DBNAME_MAIN = "main"

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

async function isAuth(req, res, next){

  const sessionid = req.cookies['sessionid']
  const type = req.cookies['user_type']
  const username = req.cookies['username']

  if (!(sessionid && type && username))
  {
    res.clearCookie('sessionid')
    res.clearCookie('user_type')
    res.clearCookie('username')
    return res.status(400).send('User not properly LogedIn')
  }

  if (!(type == 'student_users' || type == 'teacher_users'))
  {
    return res.status(400).send('either missing type argument or type is not equal to teacher_users or student_users')
  }

  const db = await getDBConnection(), lookfor = type.substring(0, type.indexOf('_')+1)+'id'

  const query = `SELECT ${lookfor} FROM ${type} WHERE session_id = ? AND ${lookfor} = ?;`
  const cookieMatchDB = await db.all(query, [sessionid, username])

  if(!cookieMatchDB.length)
  {
    res.clearCookie('sessionid')
    res.clearCookie('user_type')
    res.clearCookie('username')
    return res.status(400).send('User not properly LogedIn')
  }

  req.sessionid = cookieMatchDB[0][lookfor]
  req.user_table = type
  req.username = username
  await db.close()
  next()
}

  //base server check
app.post('/isAuth', isAuth, (req, res) => {
  res.send('user isAuthenticated');
});

//Retrieve course list (all courses ever)
app.get('/GetEntireCourseList', async function(req, res) {

  try {
    const db = await getDBConnection();
    const courses = await db.all('SELECT * FROM courses ORDER BY code_type;');
    await db.close();
    res.json(courses);
  } catch (err) {
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }
  if(db) await db.close();
});
//Retrieve course list (currently active courses)
app.get('/GetActiveCourseList', async function(req, res) {

  try {
    const db = await getDBConnection();
    const courses = await db.all('SELECT * FROM derived_courses JOIN courses ON courses.id = derived_courses.course_id AND derived_courses.is_active = TRUE;');
    await db.close();
    res.json(courses);
  } catch (err) {
    console.log(err)
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }
  if(db) await db.close()
});
//TODO: add a /getuserbyID endpoint for riko

//Retrieve courses by course type, number and season
app.get('/searchCourses', async function(req, res){

  const type = `%${req.body.courseType}%`;
  const number = `%${req.body.courseNum}%`;
  const season = `%${req.body.courseSeason}%`;

  try{
    const connection = await getDBConnection();
    console.log(type, number, season)
    const query = `SELECT * FROM courses WHERE courses.code_type LIKE ? AND courses.code_number LIKE ? AND courses.season LIKE ?`;
    const searchResult = await connection.all(query,[type, number, season]);
    const output = {filteredCourses : searchResult};
    console.log(searchResult)

    await connection.close();

    res.json(output);

  }catch(err){
    console.log(err)
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }
});

//Retrieve individual course information, preqs and instructor info
app.get('/getCourseInfo', async function(req, res){

  const courseId = req.body.courseId;

  if (!courseId){
    res.status(USER_ERROR).send(USER_ERROR_ENDPOINT_MSG);
  }
  else{
    let connection
    try{
      const connection = await getDBConnection();
      let query = "SELECT courses.code_type, courses.code_number, derived_courses.* FROM derived_courses JOIN courses ON courses.id = derived_courses.course_id WHERE ? = courses.id;";
      const courseResult = await connection.all(query, [courseId]);
      query = "SELECT course_requirements.pre_req_id, courses.code_type, courses.code_number FROM course_requirements JOIN courses ON course_requirements.course_id = ? WHERE courses.id = course_requirements.pre_req_id;";
      const requirementsResult = await connection.all(query, [courseId]);
      query = "SELECT person.* FROM person JOIN teachers ON person.id = teachers.teacher_id JOIN derived_courses ON teachers.teacher_id = derived_courses.teacher_id WHERE derived_courses.course_id = ?;";
      const instructorResult = await connection.all(query, [courseId]);
      const output = {courseInfo : courseResult, instructorInfo : instructorResult, requirementsInfo : requirementsResult};
      
      await connection.close();
      
      res.json(output);
    }catch(err){
      res.type('text');
      res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
    }
    if(connection) await connection.close()
  }
});


//check if the username and password are valid
app.get('/checkUserCreds', async function(req, res) {

  const userid = req.body.username;
  const password = req.body.password;

  if (!(userid && password)) {
    res.status(USER_ERROR).send(USER_ERROR_ENDPOINT_MSG);
  }
  else {
    let connection
    try {
      const connection = await getDBConnection();
      //check the teacher_user table
      let query = "SELECT teacher_id FROM teacher_users WHERE teacher_id = ? AND password = ?";
      let result = await connection.all(query, [userid, password]);
      //check the student_users table
      query = "SELECT student_id FROM student_users WHERE student_id = ? AND password = ?";
      result.push(await connection.all(query, [userid,password]));
      if (result.length == 0) {
        res.status(USER_ERROR).send(USER_ERROR_NO_USER_MSG);
      }
      else {
        const userFound = {"validCredentials" : "True"};
        res.status(USER_ERROR).json(userFound);
      }
    } catch (err) {
      res.status(SERVER_ERROR).send(SERVER_ERROR_MSG);
    }
    if(connection) await connection.close()
  }
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});


app.post('/login', async (req, res) => {
  const { username, password, type } = req.body

  if (!username || !password) {
    if (!username && !password) return res.status(400).send('missing arguments username and password')
    else if (!username) return res.status(400).send('missing argument username')
    else return res.status(400).send('missing argument password')
  }

  if (!(type == 'student_users' || type == 'teacher_users'))
  {
    return res.status(400).send('either missing type argument or type is not equal to teacher_users or student_users')
  }


  const db = await getDBConnection(), lookfor = type.substring(0, type.indexOf('_')+1)+'id'
  let query = `SELECT ${lookfor} FROM ${type} WHERE ${lookfor} = ? AND password = ?;`

  let result = await db.all(query, [username, password])

  if (result.length) {
    let id = await getSessionId(type)
    let q = `UPDATE ${type} SET session_id = ? WHERE ${lookfor} = ?;`
    await db.run(q, [id, username])

    const expDate = new Date(Date.now() + 10 * 60 * 1000)

    res.cookie('sessionid', id, { expires: expDate, sameSite: 'none' })
    res.cookie('user_type', type, {expires: expDate, sameSite: 'none'})
    res.cookie('username', result[0][lookfor], {expires: expDate, sameSite: 'none'})
    res.send('Login Successful')
  } else {
    res.status(400).send('Invalid credentails.')
  }

  await db.close()
})

app.post('/logout', isAuth, async (req, res) => {

  const db = await getDBConnection()
  const q = `UPDATE ${req.user_table} SET session_id = NULL WHERE session_id = ?;`
    await db.run(q, [req.sessionid])
    res.clearCookie('sessionid').send('Successfully logged out!')

  await db.close()

})

/**
* Establishes a database connection to a database and returns the database object.
* Any errors that occur during connection should be caught in the function
* that calls this one.
* @returns {Object} - The database object for the connection.
*/
async function getDBConnection() {
  const db = await sqlite.open({
    filename: '../database/main.db',
    driver: sqlite3.Database
  });
  return db;
}

/**
 * Generates an unused sessionid and returns it to the user.
 * @returns {string} - The random session id.
 */
async function getSessionId(type) {
  let query = `SELECT session_id FROM ${type} WHERE session_id = ?;`
  let id;
  let db = await getDBConnection();
  do {
    // This wizardry comes from https://gist.github.com/6174/6062387
    id = Math.random().toString(36)
      .substring(2, 15) + Math.random().toString(36)
        .substring(2, 15);
  } while (((await db.all(query, id)).length) > 0);
  await db.close();
  return id;
}