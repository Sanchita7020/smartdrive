const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();

const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

// =====================================================
// SMARTDRIVE CONNECTIONS
// =====================================================

// ESP32 devices
const devices = new Map();

// Browser clients
const clients = new Set();

// Active download mapping
//
// request_id -> {
//   client: WebSocket,
//   deviceId: string,
//   startedAt: number
// }
const downloads = new Map();

// One active download per device for this MVP
//
// deviceId -> request_id
const activeDownloadByDevice = new Map();


// =====================================================
// HTTP HEALTH CHECK
// =====================================================

app.get("/", (req, res) => {

  res.json({
    service: "SmartDrive Relay",
    status: "running",
    connected_devices: devices.size,
    connected_clients: clients.size
  });

});


// =====================================================
// WEBSOCKET SERVER
// =====================================================

const wss = new WebSocketServer({
  server,
  path: "/ws"
});


// =====================================================
// HELPER: SEND JSON
// =====================================================

function sendJSON(ws, object) {

  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {

    ws.send(
      JSON.stringify(object)
    );

  }

}


// =====================================================
// HELPER: DEVICE ONLINE CHECK
// =====================================================

function getDevice(deviceId) {

  const ws = devices.get(deviceId);

  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {

    return null;

  }

  return ws;
}


// =====================================================
// WEBSOCKET CONNECTION
// =====================================================

wss.on("connection", (ws, request) => {

  console.log(
    "WebSocket client connected"
  );

  let role = null;
  let deviceId = null;

  // Add to browser-client set.
  // It will be removed automatically later
  // if this turns out to be an ESP32.
  clients.add(ws);


  // ---------------------------------------------------
  // INITIAL ACK
  // ---------------------------------------------------

  sendJSON(ws, {

    type: "connected",

    message:
      "Connected to SmartDrive relay"

  });


  // ---------------------------------------------------
  // MESSAGE HANDLER
  // ---------------------------------------------------

  ws.on("message", (data, isBinary) => {

    // =================================================
    // BINARY DATA
    // =================================================

    if (isBinary) {

      // Binary data is expected from ESP32
      // during an active download.

      if (
        role !== "device" ||
        !deviceId
      ) {

        console.log(
          "Binary message from unknown client"
        );

        return;
      }


      const requestId =
        activeDownloadByDevice.get(
          deviceId
        );


      if (!requestId) {

        console.log(
          `Binary data received from ${deviceId} without active download`
        );

        return;
      }


      const download =
        downloads.get(requestId);


      if (
        !download ||
        !download.client ||
        download.client.readyState !==
          WebSocket.OPEN
      ) {

        console.log(
          `Download client unavailable: ${requestId}`
        );

        return;
      }


      // -------------------------------------------------
      // FORWARD BINARY DIRECTLY
      // -------------------------------------------------

      download.client.send(
        data,
        {
          binary: true
        }
      );


      console.log(
        `Forwarded binary chunk: ${requestId} (${data.length} bytes)`
      );

      return;
    }


    // =================================================
    // TEXT MESSAGE
    // =================================================

    let message;

    try {

      message =
        JSON.parse(
          data.toString()
        );

    } catch (error) {

      sendJSON(ws, {

        type: "error",

        message:
          "Invalid JSON"

      });

      return;
    }


    console.log(
      "Message:",
      message
    );


    // =================================================
    // DEVICE REGISTRATION
    // =================================================

    if (
      message.type ===
      "device_register"
    ) {

      role = "device";

      // Remove this WebSocket from browser set.
      clients.delete(ws);

      deviceId =
        message.device_id;


      if (!deviceId) {

        sendJSON(ws, {

          type: "error",

          message:
            "device_id is required"

        });

        return;
      }


      // Replace old connection if necessary
      devices.set(
        deviceId,
        ws
      );


      sendJSON(ws, {

        type:
          "device_registered",

        device_id:
          deviceId,

        status:
          "online"

      });


      console.log(
        `ESP32 registered: ${deviceId}`
      );


      return;
    }


    // =================================================
    // CLIENT REGISTRATION
    // =================================================

    if (
      message.type ===
      "client_register"
    ) {

      role = "client";

      clients.add(ws);


      sendJSON(ws, {

        type:
          "client_registered",

        status:
          "ready"

      });


      console.log(
        "Website client registered"
      );


      return;
    }


    // =================================================
    // WEBSITE -> ESP32
    // =================================================

    if (
      role === "client"
    ) {

      const targetDeviceId =
        message.device_id;


      if (!targetDeviceId) {

        sendJSON(ws, {

          type: "error",

          message:
            "device_id is required"

        });

        return;
      }


      const device =
        getDevice(
          targetDeviceId
        );


      if (!device) {

        sendJSON(ws, {

          type:
            "device_offline",

          device_id:
            targetDeviceId

        });

        return;
      }


      // =================================================
      // DOWNLOAD REQUEST
      // =================================================

      if (
        message.type ===
        "download_request"
      ) {

        const requestId =
          message.request_id;


        if (!requestId) {

          sendJSON(ws, {

            type:
              "download_error",

            request_id:
              null,

            message:
              "request_id is required"

          });

          return;
        }


        // Only one download at a time per device
        if (
          activeDownloadByDevice.has(
            targetDeviceId
          )
        ) {

          sendJSON(ws, {

            type:
              "download_error",

            request_id:
              requestId,

            message:
              "Device is already downloading another file"

          });

          return;
        }


        downloads.set(
          requestId,
          {
            client: ws,
            deviceId: targetDeviceId,
            startedAt: Date.now()
          }
        );


        activeDownloadByDevice.set(
          targetDeviceId,
          requestId
        );


        // Forward request to ESP32

        sendJSON(device, {

          ...message,

          forwarded_by:
            "smartdrive-relay"

        });


        console.log(
          `Download request ${requestId} -> ${targetDeviceId}`
        );


        return;
      }


      // =================================================
      // NORMAL WEBSITE -> ESP32
      // =================================================

      sendJSON(device, {

        ...message,

        forwarded_by:
          "smartdrive-relay"

      });


      console.log(
        `Forwarded client -> ${targetDeviceId}: ${message.type}`
      );


      return;
    }


    // =================================================
    // ESP32 -> WEBSITE
    // =================================================

    if (
      role === "device"
    ) {

      // -------------------------------------------------
      // DOWNLOAD START
      // -------------------------------------------------

      if (
        message.type ===
        "download_start"
      ) {

        const requestId =
          message.request_id;


        const download =
          downloads.get(
            requestId
          );


        if (!download) {

          console.log(
            `Unknown download request: ${requestId}`
          );

          return;
        }


        sendJSON(
          download.client,
          message
        );


        console.log(
          `Download started: ${requestId}`
        );


        return;
      }


      // -------------------------------------------------
      // DOWNLOAD COMPLETE
      // -------------------------------------------------

      if (
        message.type ===
        "download_complete"
      ) {

        const requestId =
          message.request_id;


        const download =
          downloads.get(
            requestId
          );


        if (download) {

          sendJSON(
            download.client,
            message
          );

        }


        downloads.delete(
          requestId
        );


        if (
          activeDownloadByDevice.get(
            deviceId
          ) === requestId
        ) {

          activeDownloadByDevice.delete(
            deviceId
          );

        }


        console.log(
          `Download complete: ${requestId}`
        );


        return;
      }


      // -------------------------------------------------
      // DOWNLOAD ERROR
      // -------------------------------------------------

      if (
        message.type ===
        "download_error"
      ) {

        const requestId =
          message.request_id;


        const download =
          downloads.get(
            requestId
          );


        if (download) {

          sendJSON(
            download.client,
            message
          );

        }


        downloads.delete(
          requestId
        );


        if (
          activeDownloadByDevice.get(
            deviceId
          ) === requestId
        ) {

          activeDownloadByDevice.delete(
            deviceId
          );

        }


        console.log(
          `Download error: ${requestId}`
        );


        return;
      }


      // -------------------------------------------------
      // OTHER ESP32 JSON
      // -------------------------------------------------

      for (
        const client of clients
      ) {

        if (
          client !== ws &&
          client.readyState ===
            WebSocket.OPEN
        ) {

          sendJSON(
            client,
            {
              ...message,
              device_id:
                message.device_id ||
                deviceId
            }
          );

        }

      }


      console.log(
        `ESP32 ${deviceId} -> clients: ${message.type}`
      );


      return;
    }


    // =================================================
    // UNKNOWN CLIENT STATE
    // =================================================

    sendJSON(ws, {

      type: "error",

      message:
        "Register as device or client first"

    });

  });


  // ===================================================
  // CLOSE
  // ===================================================

  ws.on("close", () => {

    clients.delete(ws);


    // -------------------------------------------------
    // ESP32 disconnected
    // -------------------------------------------------

    if (
      role === "device" &&
      deviceId
    ) {

      if (
        devices.get(deviceId) ===
        ws
      ) {

        devices.delete(
          deviceId
        );

      }


      // Cancel active download
      const requestId =
        activeDownloadByDevice.get(
          deviceId
        );


      if (requestId) {

        const download =
          downloads.get(
            requestId
          );


        if (download) {

          sendJSON(
            download.client,
            {
              type:
                "download_error",

              request_id:
                requestId,

              message:
                "ESP32 disconnected during download"
            }
          );

        }


        downloads.delete(
          requestId
        );


        activeDownloadByDevice.delete(
          deviceId
        );

      }


      console.log(
        `ESP32 disconnected: ${deviceId}`
      );


      return;
    }


    // -------------------------------------------------
    // Browser disconnected
    // -------------------------------------------------

    console.log(
      "Website client disconnected"
    );


    // Cancel downloads belonging to client
    for (
      const [
        requestId,
        download
      ] of downloads
    ) {

      if (
        download.client === ws
      ) {

        downloads.delete(
          requestId
        );


        if (
          activeDownloadByDevice.get(
            download.deviceId
          ) === requestId
        ) {

          activeDownloadByDevice.delete(
            download.deviceId
          );

        }

      }

    }

  });


  // ===================================================
  // ERROR
  // ===================================================

  ws.on("error", (error) => {

    console.error(
      "WebSocket error:",
      error.message
    );

  });

});


// =====================================================
// DOWNLOAD TIMEOUT CLEANUP
// =====================================================

setInterval(() => {

  const now =
    Date.now();

  for (
    const [
      requestId,
      download
    ] of downloads
  ) {

    // 5 minute safety timeout
    if (
      now -
      download.startedAt >
      5 * 60 * 1000
    ) {

      console.log(
        `Download timeout: ${requestId}`
      );


      sendJSON(
        download.client,
        {
          type:
            "download_error",

          request_id:
            requestId,

          message:
            "Download timed out"
        }
      );


      downloads.delete(
        requestId
      );


      if (
        activeDownloadByDevice.get(
          download.deviceId
        ) === requestId
      ) {

        activeDownloadByDevice.delete(
          download.deviceId
        );

      }

    }

  }

}, 30000);


// =====================================================
// START SERVER
// =====================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `SmartDrive Relay running on port ${PORT}`
    );

  }
);
