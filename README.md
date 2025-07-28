
# Fermion Assignment

## Overview

This project is a full-stack WebRTC streaming platform built with Next.js and Express. It allows users to broadcast their webcam stream, and view all active streams. The backend uses WebSocket for real-time stream management.

## Features

- **WebRTC streaming**: Broadcast your webcam and microphone to the room.
- **Real-time updates**: Streams are managed and synchronized via WebSocket.

## Tech Stack

- **Languages**: Typescript, Javascript
- **Frontend**: Next.js, React, Tailwind CSS
- **Backend**: Express, ws (WebSocket), Mediasoup
- **Monorepo**: pnpm, Turborepo

## Getting Started

1. **Clone the repo**
   ```bash
   git clone https://github.com/chundawatchatar/fermion-assignment.git
   cd fermion-assignment
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Start development servers**
   ```bash
   pnpm dev
   ```

## Usage

- **To stream:** Open [http://localhost:3000/stream](http://localhost:3000/stream) in your browser (Chrome recommended).
- **To watch:** Open [http://localhost:3000/watch](http://localhost:3000/watch) in another tab or device.

**Author:** [chatar](https://github.com/chundawatchatar)
