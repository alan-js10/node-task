import cookieParser from "cookie-parser";
import cors from "cors";
import mysql from "mysql";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import fileUpload from "express-fileupload";
import xlsx from "xlsx";
import dotenv from "dotenv";
import http from "http";
import moment from "moment";
import express, { NextFunction, Request, Response } from 'express';

declare global {
    namespace Express {
        interface Request {
            currentUser?: any;
        }
    }
}
dotenv.config();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(fileUpload())
app.use(cors({
    credentials: true
}))

export interface ChatData {
    user: string;
    message: string;
    timestamp: Date;
}

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'chat',
});

// Connect to MySQL
db.connect((err) => {
    if (err) {
        console.error('Could not connect to MySQL:', err);
        process.exit(1);
    }
    console.log('Connected to MySQL!');
});

app.post("/register", async (req: Request, res: Response) => {
    const { userName, password } = req.body;
    try {
        const existing = db.query("select * from users where username = ?", [userName]);
        if (existing) {
            res.status(409).json({ message: "User exists" });
        }
        const hased = bcrypt.hash(password, 10);
        db.query("insert into users (userName, password) values(?,?)", [userName, hased])
        res.status(201).json({ message: "User Registered successfully" })

    } catch (error) {
        res.status(500).json({ message: "Registration failed" })
    }
})

function generateToken(user: { userName: string }) {
    const accessToken = jwt.sign(user, process.env.ACCESS_SECRET, { expiresIn: "10m" })
    const refreshToken = jwt.sign(user, process.env.REFRESH_SECRET, { expiresIn: "1d" })
    return { accessToken, refreshToken };
}

app.post("/login", async (req: Request, res: Response) => {
    const { userName, password } = req.body;
    try {
        const [rows]: any = await new Promise((resolve, reject) => {
            db.query("select * from users where username = ?", [userName], (err, results) => {
                if (err) reject(err);
                else resolve(results);
            });
        });

        const user = rows[0];
        if (!user || !(await bcrypt.compare(password, user.password))) {
            res.status(401).json({ message: "Invalid cred" })
        }
        const tokens = generateToken({ userName });

        res.cookie("refreshToken", tokens.refreshToken, {
            httpOnly: true,
            secure: false,
            // sameSite:"Lax",
        })

        res.json({ accessToken: tokens.accessToken })
    } catch (error) {
        res.status(500).json({ message: "Login failed" })
    }
})

app.post("/refresh", async (req: Request, res: Response) => {
    const token = req.cookies.refreshToken;
    if (!token) {
        res.status(401).json({ message: "No token" });
    }
    try {
        if (!process.env.REFRESH_SECRET) {
            throw new Error("REFRESH_SECRET is not defined in environment variables");
        }
        const user = jwt.verify(token, process.env.REFRESH_SECRET) as jwt.JwtPayload;
        const tokens = generateToken({ userName: user.userName as string });

        res.json({ accessToken: tokens.accessToken })

        res.cookie("refreshToken", tokens.refreshToken, {
            httpOnly: true,
            secure: false,
            // sameSite:"Lax",
        })

    } catch (error) {
        res.status(500).json({ message: "Invalid token" })
    }
})

function authenticateToken(req: Request, res: Response, next: NextFunction): void {
    const token = req.cookies.refreshToken;

    if (!token) {
        res.status(401).json({ message: "No token provided" });
        return;
    }

    jwt.verify(token, process.env.REFRESH_SECRET!, (err: any, user: any) => {
        if (err) {
            res.status(403).json({ message: "Invalid or expired token" });
            return;
        }
        req.currentUser = user;
        next();
    });
}

app.post("/upload-chat-history", authenticateToken, async (req: Request, res: Response) => {
    const file = req.files?.file;

    try {
        const workbook = xlsx.read(file?.data, { type: "buffer" })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]; // Assuming chat history is in the first sheet

        // Convert the sheet to JSON
        const chatData: ChatData[] = xlsx.utils.sheet_to_json(sheet);

        // Validate and process the data
        const validChatData: ChatData[] = chatData.map((row: any) => {
            return {
                user: row.User, // Adjust according to your column names
                message: row.Message,
                timestamp: moment(row.Timestamp, 'YYYY-MM-DD HH:mm:ss').toDate(), // Adjust timestamp format
            };
        }).filter(row => row.user && row.message && row.timestamp);

        if (validChatData.length === 0) {
            res.status(400).send('No valid chat data found.');
        }

        const insertQueries = validChatData.map((row) => {
            return new Promise((resolve, reject) => {
                const query = 'INSERT INTO chats (user, message, timestamp) VALUES (?, ?, ?)';
                db.query(query, [row.user, row.message, row.timestamp], (err, result) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(result);
                    }
                });
            });
        });

        Promise.all(insertQueries)
            .then(() => res.send('Chat history successfully uploaded!'))
            .catch((error) => res.status(500).send('Error uploading chat history: ' + error));

    } catch (error) {
        res.status(500).json({ message: "Invalid token" })
    }
})

const server = http.createServer(app);
server.listen(8080, () => console.log("Server running"))