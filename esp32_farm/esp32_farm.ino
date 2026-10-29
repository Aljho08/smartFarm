#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <ArduinoJson.h>

// --- PIN DEFINITIONS ---
#define DHTPIN          23       // DHT11 Out[cite: 1]
#define DHTTYPE         DHT11
#define SOIL_PIN_PLOT_A 34       // Soil Moisture Sensor 1 (Plot A)[cite: 1]
#define SOIL_PIN_PLOT_B 35       // Soil Moisture Sensor 2 (Plot B)[cite: 1]
#define RELAY_PIN       25       // Relay module IN pin[cite: 1]

// --- THRESHOLDS & CALIBRATION ---
// Adjust wet/dry raw ADC values per sensor if needed
const int DRY_SOIL_ADC_A = 3200;  // Plot A dry air baseline
const int WET_SOIL_ADC_A = 1800;  // Plot A fully submerged/wet baseline

const int DRY_SOIL_ADC_B = 3200;  // Plot B dry air baseline
const int WET_SOIL_ADC_B = 1800;  // Plot B fully submerged/wet baseline

const float START_IRRIGATION_THRESHOLD = 35.0; // Relay ON below 35%[cite: 2]
const float STOP_IRRIGATION_THRESHOLD  = 60.0; // Relay OFF above 60%[cite: 2]

// --- NETWORK CONFIGURATION ---
const char* WIFI_SSID     = "TeamJN 2.4G";
const char* WIFI_PASSWORD = "PLDTWIFIY2dsd";
//const char* WIFI_SSID     = "ScottiePogi2.4";
//const char* WIFI_PASSWORD = "f4t4ll4r3sid3nc3";

const char* MQTT_SERVER   = "192.168.1.202";  // Node.js / MQTT broker IP[cite: 2]
const int   MQTT_PORT     = 1883;
const char* TOPIC_DATA    = "smartfarm/telemetry";
const char* TOPIC_CONTROL = "smartfarm/pump/control";

// --- GLOBAL OBJECTS & VARIABLES ---
DHT dht(DHTPIN, DHTTYPE);
WiFiClient espClient;
PubSubClient mqttClient(espClient);

unsigned long lastSensorReadTime  = 0;
unsigned long lastMqttPublishTime = 0;
const unsigned long SENSOR_INTERVAL  = 3000;   // Read sensors & evaluate logic every 3 seconds
const unsigned long PUBLISH_INTERVAL = 15000;  // Periodic MQTT telemetry publish every 15 seconds

#define RELAY_ON  LOW
#define RELAY_OFF HIGH

bool manualOverride = false;
bool isPumpActive   = false;
bool lastPumpState  = false;

// Function Declarations
void setupWiFi();
void reconnectMQTT();
void callback(char* topic, byte* payload, unsigned int length);
float readSoilMoisturePercent(int pin, int dryAdc, int wetAdc);
void publishTelemetry(float temp, float hum, float soilA, float soilB, const char* triggerType, const char* initiatedByUserId = nullptr);

void setup() {
  Serial.begin(115200);

  // Initialize Relay
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_OFF);

  // Initialize Pin Inputs[cite: 1]
  pinMode(SOIL_PIN_PLOT_A, INPUT);
  pinMode(SOIL_PIN_PLOT_B, INPUT);

  // Start Sensors & WiFi
  dht.begin();
  setupWiFi();
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(callback);
}

void loop() {
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  unsigned long currentMillis = millis();

  // 1. Read Sensors and process automation every 3 seconds
  if (currentMillis - lastSensorReadTime >= SENSOR_INTERVAL) {
    lastSensorReadTime = currentMillis;

    float humidity = dht.readHumidity();
    float temperature = dht.readTemperature();
    
    float soilMoistureA = readSoilMoisturePercent(SOIL_PIN_PLOT_A, DRY_SOIL_ADC_A, WET_SOIL_ADC_A);
    float soilMoistureB = readSoilMoisturePercent(SOIL_PIN_PLOT_B, DRY_SOIL_ADC_B, WET_SOIL_ADC_B);

    if (isnan(humidity) || isnan(temperature)) {
      Serial.println("Failed to read from DHT sensor!");
      return;
    }

    // 2. Dual-Plot Automation Logic[cite: 2]
    bool stateChanged = false;
      if (!manualOverride) {
        if (soilMoistureA <= START_IRRIGATION_THRESHOLD && !isPumpActive) {
          digitalWrite(RELAY_PIN, RELAY_ON);
          isPumpActive = true;
          stateChanged = true;
          Serial.printf("[AUTO] Plot A moisture %.1f%% low. Pump ON.\n", soilMoistureA);
        } 
        else if (soilMoistureA >= STOP_IRRIGATION_THRESHOLD && isPumpActive) {
          digitalWrite(RELAY_PIN, RELAY_OFF);
          isPumpActive = false;
          stateChanged = true;
          Serial.printf("[AUTO] Plot A moisture %.1f%% high. Pump OFF.\n", soilMoistureA);
        }
      }

    // 3. Serial Debugging
    Serial.printf("Temp: %.1f°C | Hum: %.1f%% | Plot A: %.1f%% | Plot B: %.1f%% | Pump: %s\n", 
                  temperature, humidity, soilMoistureA, soilMoistureB, isPumpActive ? "ON" : "OFF");

    // 4. Send JSON Payload over MQTT[cite: 2]
    // Publish immediately on state change OR periodically every 15 seconds
    if (stateChanged || (currentMillis - lastMqttPublishTime >= PUBLISH_INTERVAL)) {
      lastMqttPublishTime = currentMillis;
      lastPumpState = isPumpActive;

      const char* trigger = stateChanged ? "EVENT_AUTO" : "PERIODIC";
      publishTelemetry(temperature, humidity, soilMoistureA, soilMoistureB, trigger);
    }
  }
}

// Convert ADC Reading to Percentage
float readSoilMoisturePercent(int pin, int dryAdc, int wetAdc) {
  int rawADC = analogRead(pin);
  float percentage = map(rawADC, dryAdc, wetAdc, 0, 100);
  return constrain(percentage, 0.0, 100.0);
}

// Publish Structured JSON Telemetry to MQTT[cite: 2]
void publishTelemetry(float temp, float hum, float soilA, float soilB, const char* triggerType, const char* initiatedByUserId) {
  StaticJsonDocument<384> doc;
  doc["temperature"]   = temp;
  doc["humidity"]      = hum;
  doc["soilMoistureA"] = soilA;
  doc["soilMoistureB"] = soilB;
  doc["pumpState"]     = isPumpActive ? "ON" : "OFF";
  doc["trigger"]       = triggerType;
  if (initiatedByUserId && initiatedByUserId[0] != '\0') {
    doc["initiatedByUserId"] = initiatedByUserId;
  }

  char jsonBuffer[384];
  serializeJson(doc, jsonBuffer);
  mqttClient.publish(TOPIC_DATA, jsonBuffer);
  Serial.printf("[MQTT PUBLISH - %s]: %s\n", triggerType, jsonBuffer);
}

void runTimedIrrigation(int pin, int dryAdc, int wetAdc, float stopThreshold) {
  float soilMoisture = readSoilMoisturePercent(pin, dryAdc, wetAdc);

  while (soilMoisture < stopThreshold) {
    // Pump ON for 5 seconds
    digitalWrite(RELAY_PIN, RELAY_ON);
    isPumpActive = true;
    Serial.printf("[TIMED] Pump ON for 5s | Soil: %.1f%%\n", soilMoisture);
    delay(3000);

    // Pump OFF for 3 seconds
    digitalWrite(RELAY_PIN, RELAY_OFF);
    isPumpActive = false;
    Serial.println("[TIMED] Pump OFF for 3s");
    delay(3000);

    // Re-check soil moisture
    soilMoisture = readSoilMoisturePercent(pin, dryAdc, wetAdc);
    Serial.printf("[CHECK] Soil moisture now %.1f%%\n", soilMoisture);
  }

  Serial.printf("[STOP] Irrigation complete. Soil moisture reached %.1f%%\n", soilMoisture);
}

void setupWiFi() {
  delay(10);
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected. IP address: ");
  Serial.println(WiFi.localIP());
}

void callback(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<192> commandDoc;
  DeserializationError parseError = deserializeJson(commandDoc, payload, length);
  String command;
  String initiatedByUserId;

  if (!parseError) {
    command = commandDoc["command"] | "";
    initiatedByUserId = commandDoc["initiatedByUserId"] | "";
  } else {
    for (unsigned int i = 0; i < length; i++) {
      command += (char)payload[i];
    }
  }

  Serial.printf("MQTT Control Received [%s]: %s\n", topic, command.c_str());

  if (String(topic) == TOPIC_CONTROL) {
    bool stateChanged = false;

    if (command == "ON") {
      manualOverride = true;
      if (!isPumpActive) stateChanged = true;
      digitalWrite(RELAY_PIN, RELAY_ON);
      isPumpActive = true;
      Serial.println("[MANUAL OVERRIDE] Relay switched ON");
    } else if (command == "OFF") {
      manualOverride = true;
      if (isPumpActive) stateChanged = true;
      digitalWrite(RELAY_PIN, RELAY_OFF);
      isPumpActive = false;
      Serial.println("[MANUAL OVERRIDE] Relay switched OFF");
    } else if (command == "AUTO") {
      manualOverride = false;
      Serial.println("[MODE] Switched back to AUTO threshold mode");
    }

    // Immediately publish status update upon receiving a manual command
    float humidity = dht.readHumidity();
    float temperature = dht.readTemperature();
    float soilMoistureA = readSoilMoisturePercent(SOIL_PIN_PLOT_A, DRY_SOIL_ADC_A, WET_SOIL_ADC_A);
    float soilMoistureB = readSoilMoisturePercent(SOIL_PIN_PLOT_B, DRY_SOIL_ADC_B, WET_SOIL_ADC_B);
    
    publishTelemetry(temperature, humidity, soilMoistureA, soilMoistureB, "EVENT_MANUAL", initiatedByUserId.c_str());
  }
}

void reconnectMQTT() {
  while (!mqttClient.connected()) {
    Serial.print("Attempting MQTT connection...");
    String clientId = "ESP32Client-" + String(random(0xffff), HEX);
    
    if (mqttClient.connect(clientId.c_str())) {
      Serial.println("connected");
      mqttClient.subscribe(TOPIC_CONTROL);
    } else {
      Serial.print("failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" try again in 5 seconds");
      delay(5000);
    }
  }
}