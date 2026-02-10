# LocationPingServ Project Summary

## 📌 Project Overview
**LocationPingServ** is a specialized Node.js/Express backend designed to act as a centralized "Layer 2 Switch" for a Minecraft Mod. It manages active player sessions, Role-Based Access Control (RBAC), and transient "Ping" data (sharing locations between players).

## 🏗️ Architecture
*   **Runtime:** Node.js + Express
*   **Deployment:** Render (Web Service)
*   **Database:** MongoDB Atlas (Used for persistent Blacklist storage)
*   **State Management:** In-Memory (RAM) for active Pings and User Sessions.

## 🔐 Credentials & Access
The system uses the **AAA Model** (Authentication, Authorization, Accounting).

### Environment Variables
These are configured in the Render Dashboard:
*   `PASSWORD_USER`: Default `Espan@1500$$`
*   `PASSWORD_ADMIN`: Default `Adm1nEsp@na#@`
*   `MONGODB_URI`: Connection string to MongoDB Atlas.

### Roles
1.  **USER**: Standard player. Can post `LOCATION` pings (one at a time) and view all data.
2.  **ADMIN**: Moderator. Can post `COORD` pings (permanent), manage the Blacklist, and delete any data.

## 🔌 API Reference

### 1. Authentication
*   **Endpoint:** `POST /api/auth/login`
*   **Body:** `{"username": "PlayerName", "password": "..."}`
*   **Response:** `{ "token": "uuid...", "role": "USER" }`

### 2. Pings (The Switch)
*   **Fetch Pings:** `GET /api/pings` (Requires `X-Auth-Token` header)
*   **Send Ping:** `POST /api/pings`
    *   **User Ping (`LOCATION`):** Auto-deletes user's previous ping.
    *   **Admin Ping (`COORD`):** Permanent marker.
*   **Delete Ping:** `DELETE /api/pings/:id`

### 3. Blacklist (Admin Only)
*   **Add Ban:** `POST /api/blacklist` -> `{"username": "BadActor"}`
*   **Remove Ban:** `DELETE /api/blacklist` -> `{"username": "BadActor"}`
*   **List Bans:** `GET /api/blacklist`

## 🚀 deployment Status
*   **Live URL:** `https://locationpingserv.onrender.com`
*   **Database:** Connected to MongoDB Atlas Cluster `LocationPingDB`.

## 🛠️ Maintenance Limits
*   **Memory:** Pings and Sessions are stored in RAM. They reset if the server restarts (Render free tier sleeps after 15 mins of inactivity).
*   **Persistence:** The Blacklist is the **only** data that survives a restart (stored in MongoDB).
