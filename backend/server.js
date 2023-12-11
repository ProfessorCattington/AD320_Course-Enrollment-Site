'use strict';
const express = require('express');

const app = express();
const cors = require('cors');
const sqlite3 = require('sqlite3');
const sqlite = require('sqlite');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const uuid = require('uuid');
const PORT = 8000

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(multer().none());
app.use(cookieParser());

//CONSTANTS
const PREREQ_IDX = 0;
const CAPACITY_IDX = 0;
const ENROLLED = "Enrolled";
const WAITLISTED = "Waiting";
const DROPPED = "Dropped";

//ERRORS
const USER_ERROR = 400;
const USER_ERROR_ENDPOINT_MSG = "Invalid endpoint or parameters."
const USER_ERROR_NO_USER_MSG = "No userID or password for that entry."
const PREREQ_ERROR_PREREQ_NOT_MET = "Prerequisite course not completed."
const SERVER_ERROR = 500;
const SERVER_ERROR_MSG = "Unable to retrieve from the database: "
const DBNAME_MAIN = "main"

//HAPPY RESPONSES
const ENROLLED_IN_COURSE = "You have been successfully enrolled in the course"
const ALREADY_ENROLLED = "Already enrolled into this course."
const NOT_ENROLLED = "Not enrolled in that course."
const DROPPED_COURSE = "You have successfully dropped: "
const AT_CAPACITY = "This course is at capacity. Adding student to waitlist";
const ALREADY_WAITING = "You are already on the waitlist for this course.";

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

//base server check for testing. not a real endpoint
app.post('/isAuth', isAuth, (req, res) => {
  res.send('user isAuthenticated');
});

//Endpoint for enrolling in a course
app.post('/addEnrolledCourse', isAuth, async function(req, res){
  
  const courseId = req.body.courseId;
  const studentId = req.username;

  try{
    const connection = await getDBConnection();

    //check to see if the student is already enrolled
    let query = "SELECT * FROM enrolled WHERE enrolled.student_id = ? AND enrolled.course_id = ?;";
    const enrolledCourse = await connection.all(query, [studentId, courseId]);

    if(enrolledCourse.length > 0){
      res.json({"response" : ALREADY_ENROLLED});
    }
    
    //get the prereq of this course and see if the student has completed them
    query = "SELECT course_requirements.pre_req_id FROM course_requirements JOIN courses ON course_requirements.course_id = ? WHERE courses.id = course_requirements.pre_req_id;";
    const preReq = await connection.all(query, [courseId]);
    let completedCourse = []

    if(preReq.length > 0){//There are prerequisites and we need to make sure the student has completed them
      
      const preReqId = preReq[PREREQ_IDX].pre_req_id;
      //see if this prerequisite course is in the student's completed courses records
      query = "SELECT * FROM completed WHERE completed.student_id = ? AND completed.derived_course_id = ?;";
      completedCourse = await connection.all(query, [studentId, preReqId]);
      
      if (completedCourse.length == 0){ // prerequisites not met
        res.json({"response" : PREREQ_ERROR_PREREQ_NOT_MET});
      }
    }

    //check if the course if full
    query = "SELECT * FROM enrolled WHERE enrolled.course_id = ?;";
    const enrolledCount = await connection.all(query, [courseId]);

    query = "SELECT capacity FROM derived_courses WHERE derived_courses.course_id = ?;";
    const courseCapacity = await connection.all(query, [courseId]);
    const courseFull = enrolledCount.length >= courseCapacity[CAPACITY_IDX].capacity;
    console.log(enrolledCount.length, courseCapacity[CAPACITY_IDX].capacity, courseFull)
    if (courseFull){

      //check if the student is already in the wait table
      query = "SELECT * FROM waiting WHERE student_id = ? AND derived_course_id = ?;";
      const waitingEntry = await connection.all(query, [studentId, courseId]);

      if(waitingEntry.length > 0){
        res.json({"response" : ALREADY_WAITING});
      }
      else{
      //add student to the waitlist
      query = "INSERT INTO waiting (student_id, derived_course_id) VALUES(?, ?);";
      await connection.all(query, [studentId, courseId]);

      //add entry to transaction table 
      const confirmationNumber = await addToHistory(connection, studentId, courseId, WAITLISTED);

      res.json({"response" : AT_CAPACITY,
                "confirmationNumber" : confirmationNumber});
      }
    }
    
    //user completed the prereq, isn't already enrolled and the course isn't full
    if(enrolledCourse.length == 0 && (preReq.length == 0 || completedCourse.length > 0) && !courseFull){
      //delete the course from the dropped table if they are re-enrolling
      query = "DELETE FROM dropped WHERE dropped.student_id = ? AND dropped.course_id = ?;";
      await connection.all(query,[studentId, courseId]);

      //insert the student/course into the enrolled table
      query = "INSERT INTO enrolled (student_id, course_id) VALUES (?,?)";
      await connection.all(query,[studentId, courseId]);

      const confirmationNumber = await addToHistory(connection, studentId, courseId, ENROLLED);

      res.json({"response" : ENROLLED_IN_COURSE,
                "confirmationNumber" : confirmationNumber});
    }
    await connection.close();

  }catch(err){
    console.log(err)
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }

});
//endpoint for dropping a course
app.post('/addDroppedCourse', isAuth, async function(req, res){
  
  const courseId = req.body.courseId;
  const reason = req.body.reason;
  const studentId = req.username;

  try{
    const connection = await getDBConnection();
    //check if the student is enrolled first
    let query = "SELECT * FROM enrolled WHERE enrolled.student_id = ? AND enrolled.course_id = ?;";
    const enrolledCourses = await connection.all(query, [studentId, courseId]);

    if(enrolledCourses.length > 0){ //student is enrolled 
      //Let's remove them from the enrolled table...
      query = "DELETE FROM enrolled WHERE enrolled.student_id = ? AND enrolled.course_id = ?;";
      await connection.all(query,[studentId, courseId]);

      //add the new entry into the dropped table
      query = "INSERT INTO dropped (student_id, course_id, reason) VALUES(?,?,?);";
      await connection.all(query,[studentId, courseId, reason]);

      //add an entry into history
      const droppedConfirmationNumber = await addToHistory(connection, studentId, courseId, DROPPED);

      //see if there's another student for this course on the waitlist
      query = "SELECT * FROM waiting WHERE derived_course_id = ?;";
      const studentsWaiting = await connection.all(query, [courseId]);

      //get the first student on the waitlist
      const waitingStudentId = studentsWaiting[0].student_id;

      //remove them from the waitlist
      query = "DELETE FROM waiting WHERE student_id = ? AND derived_course_id = ?;";
      await connection.all(query, [waitingStudentId, courseId]);

      //enroll them into the course that was dropped
      //TODO: Put this block into a separate function if we have time. replace this and the enrolled block
      //delete the course from the dropped table if they are re-enrolling
      query = "DELETE FROM dropped WHERE dropped.student_id = ? AND dropped.course_id = ?;";
      await connection.all(query,[waitingStudentId, courseId]);

      //insert the student/course into the enrolled table
      query = "INSERT INTO enrolled (student_id, course_id) VALUES (?,?)";
      await connection.all(query,[waitingStudentId, courseId]);

      const enrolledConfirmationNumber = await addToHistory(connection, waitingStudentId, courseId, ENROLLED);
      
      res.json({
        "response" : DROPPED_COURSE + courseId,
        "reason" : reason,
        "droppedConfirmationNumber" : droppedConfirmationNumber,
        "waitlistId" : waitingStudentId,
        "enrolledConfirmationNumber" : enrolledConfirmationNumber
      });
    }
    else{//student wasn't enrolled
      res.json({"response" : NOT_ENROLLED});
    }
    await connection.close();

  }catch(err){
    console.log(err)
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }

});

//Retrieve course list (all courses ever)
app.get('/GetEntireCourseList', isAuth, async function(req, res) {

  try {
    const connection = await getDBConnection();
    const courses = await connection.all('SELECT * FROM courses ORDER BY code_type;');
    await connection.close();
    res.json(courses);
  } catch (err) {
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }
  if(db) await db.close();
});

//Retrieve course list (currently active courses)
app.get('/GetActiveCourseList', isAuth, async function(req, res) {

  try {
    
    const connection = await getDBConnection();
    const query = 'SELECT * FROM derived_courses JOIN courses ON courses.id = derived_courses.course_id AND derived_courses.is_active = TRUE;';
    const courses = await connection.all(query);
    
    await connection.close();
    
    res.json(courses);
  } catch (err) {
    console.log(err)
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }
  if(db) await db.close()
});

//Retreive student info by id number
app.get('/getStudentById', isAuth, async function(req, res){

  const studentId = req.body.studentId;

  if(!studentId){
    res.status(USER_ERROR).send(USER_ERROR_ENDPOINT_MSG);
  }
  else{
    try{
      const connection = await getDBConnection();
      const query = 'SELECT * FROM person JOIN students ON students.id = person.id WHERE students.id = ?;';
      const studentInfo = await connection.all(query,[studentId]);
  
      await connection.close();
  
      res.json(studentInfo)
    }
    catch(err){
      console.log(err)
      res.type('text');
      res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
    }
  }
});

//Retrieve courses by course type, number and season
app.get('/searchCourses', isAuth, async function(req, res){

  const type = `%${req.body.courseType}%`;
  const number = `%${req.body.courseNum}%`;
  const season = `%${req.body.courseSeason}%`;

  try{
    const connection = await getDBConnection();
    const query = `SELECT * FROM courses WHERE courses.code_type LIKE ? AND courses.code_number LIKE ? AND courses.season LIKE ?`;
    const searchResult = await connection.all(query,[type, number, season]);
    const output = {filteredCourses : searchResult};

    await connection.close();

    res.json(output);
  }catch(err){
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }
});

//Retrieve individual course information, preqs and instructor info
app.get('/getCourseInfo', isAuth, async function(req, res){

  const courseId = req.body.courseId;

  if (!courseId){
    res.status(USER_ERROR).send(USER_ERROR_ENDPOINT_MSG);
  }
  else{
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

  try{
    const db = await getDBConnection()
    const q = `UPDATE ${req.user_table} SET session_id = NULL WHERE session_id = ?;`
    await db.run(q, [req.sessionid])
    res.clearCookie('sessionid').send('Successfully logged out!')
    await db.close()
  }
  
  catch(err){
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG);
  }
  
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

async function addToHistory( connection, studentId, courseId, action_type){

  //generate a confirmation number
  let confirmationNumber = uuid.v4();

  const query = "INSERT INTO history (student_id, course_id, confirmation_number, date_time, action_type) VALUES (?,?,?,?,?);";
  const now = new Date();
  const formattedNow = now.toISOString().split('T')[0]; //chop off the time info
  await connection.all(query,[studentId, courseId, confirmationNumber, formattedNow, action_type]);

  return confirmationNumber;
}

//get currently enrolled courses
app.post('/getEnrolledCourses', isAuth, async function(req, res){
  
  const studentId = req.username;

  try{
    const connection = await getDBConnection();
    //check if the student is enrolled first
    let query = "SELECT * FROM enrolled JOIN courses ON enrolled.course_id = courses.id JOIN derived_courses ON courses.id = derived_courses.course_id WHERE enrolled.student_id = ?";
    const enrolledCourses = await connection.all(query, [studentId]);

      res.json({"response" : enrolledCourses});

    await connection.close();

  }catch(err){
    console.log(err)
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }

});

//get Dropped courses
app.post('/getDroppedCourses', isAuth, async function(req, res){
  
  const studentId = req.username;

  try{
    const connection = await getDBConnection();
    //check if the student is enrolled first
    let query = "SELECT * FROM dropped JOIN courses ON dropped.course_id = courses.id JOIN derived_courses ON courses.id = derived_courses.course_id WHERE enrolled.student_id = ?";
    const droppedCourses = await connection.all(query, [studentId]);

      res.json({"response" : droppedCourses});

    await connection.close();

  }catch(err){
    console.log(err)
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }

});

//Retrieve course list (currently active courses)
app.get('/GetActiveCourseList', isAuth, async function(req, res) {

  try {
    
    const connection = await getDBConnection();
    const query = 'SELECT * FROM derived_courses JOIN courses ON courses.id = derived_courses.course_id AND derived_courses.is_active = TRUE;';
    const courses = await connection.all(query);
    
    await connection.close();
    
    res.json(courses);
  } catch (err) {
    console.log(err)
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }
  if(db) await db.close()
});

//Check if a student is enrolled in a class
app.get('/checkStudentEnrolledCourse', isAuth, async function(req, res){

  const studentId = req.body.studentId;
  const courseId = req.body.courseId;

  try{
    const connection = await getDBConnection();
  
    let query = "SELECT * FROM enrolled WHERE enrolled.student_id = ? AND enrolled.course_id = ?;";
    const enrolledCourse = await connection.all(query, [studentId, courseId]);

    if(enrolledCourse.length > 0){ //student is enrolled 
      res.json({"response" : "true"});
    }
    else{//student wasn't enrolled
      res.json({"response" : "false"});
    }
    await connection.close();

  }catch(err){
    console.log(err)
    res.type('text');
    res.status(SERVER_ERROR).send(SERVER_ERROR_MSG + DBNAME_MAIN);
  }

});