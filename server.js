import datetime
import os
import pyjokes
import pyttsx3
import requests
import speech_recognition as sr
import spotipy
from dotenv import load_dotenv
from google import genai
from spotipy.oauth2 import SpotifyOAuth
from gtts import gTTS
from pydub import AudioSegment
from pydub.playback import play
import io
import atexit
import signal
import sys
import threading
from calendar_utils import add_calendar_event


# Initialize nova's voice
engine = pyttsx3.init()
voices = engine.getProperty('voices')
engine.setProperty('voice', voices[1].id)  # nova's voice
listener = sr.Recognizer()

SERVER_URL = 'http://localhost:3000/log-data'  # Server URL where data is sent
productinfo = ""
weather_data = ""
ai_response = ""

load_dotenv()
SPOTIFY_CLIENT_ID = os.getenv('SPOTIFY_CLIENT_ID')
SPOTIFY_CLIENT_SECRET = os.getenv('SPOTIFY_CLIENT_SECRET')
SPOTIFY_REDIRECT_URI = os.getenv('SPOTIFY_REDIRECT_URI')

GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY')
WEATHER_API_KEY = os.getenv("WEATHER_API_KEY")

SPOTIFY_SCOPE = 'user-read-playback-state user-modify-playback-state user-read-currently-playing'
sp = spotipy.Spotify(auth_manager=SpotifyOAuth(
    client_id=SPOTIFY_CLIENT_ID,
    client_secret=SPOTIFY_CLIENT_SECRET,
    redirect_uri=SPOTIFY_REDIRECT_URI,
    scope=SPOTIFY_SCOPE
))
devices = sp.devices()["devices"]
default_device = None

exit_flag = threading.Event()

def listen_for_exit():
    while not exit_flag.is_set():
        user_input = input()
        if user_input.strip() == "/exit":
            print("Exit command received from terminal.")
            send_shutdown_status()
            exit_flag.set()
            os._exit(0)  # Immediately exits all threads

# Start thread that waits for /exit
threading.Thread(target=listen_for_exit, daemon=True).start()

def send_shutdown_status():
    data = {
        'command': 'shutdown',
        'response': 'Nova has been shut down.',
        'who_is_talking': 'System',
        'is_user_talking': False,
        'status': 'offline',
        'timestamp': str(datetime.datetime.now())
    }
    send_data_to_server(data)

# Trigger on script exit
atexit.register(send_shutdown_status)

# Also catch SIGINT (Ctrl+C)
def signal_handler(sig, frame):
    send_shutdown_status()
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)

def get_default_desktop_device():
    devices = sp.devices().get("devices", [])
    for device in devices:
        if device["type"] == "Computer" and device["is_active"]:
            return device["id"]
    return None

def get_location():
    try:
        response = requests.get("http://ip-api.com/json/?fields=status,message,countryCode,zip,city")
        data = response.json()

        if data.get("status") != "success":
            print(f"Location fetch failed: {data.get('message', 'Unknown error')}")
            return "Unknown"

        city = data.get("city", "Unknown")
        return city
    except Exception as e:
        print(f"Error getting location: {e}")
        return "Unknown"

# Weather Function
def get_weather(city):
    base_url = "http://api.weatherapi.com/v1/current.json?"

    try:
        response = requests.get(f'{base_url}key={WEATHER_API_KEY}&q={city}&aqi=no')
        data = response.json()

        if "error" in data:
            print("Error fetching weather data.")
            return None

        weather_condition = data['current'].get('condition', {}).get('text', 'No weather data available')
        temperature = data['current'].get('temp_c', 'N/A')

        # Format the weather report for TTS
        weather_report = f"Weather in {city}: {weather_condition}, {temperature}°C"

        return {
            "current": weather_report,
            "forecast": [
                {"date": "Tomorrow", "weather": "Cloudy", "temperature": "25°C"},
                {"date": "Day After Tomorrow", "weather": "Sunny", "temperature": "28°C"},
            ]
        }
    except requests.exceptions.RequestException as e:
        print(f"Error getting weather data: {e}")
        return None

# Function to send data to the server
def send_data_to_server(data):
    try:
        response = requests.post(SERVER_URL, json=data)
        if response.status_code == 200:
            print("Data sent successfully.")
        else:
            print(f"Failed to send data: {response.status_code}")
    except Exception as e:
        print(f"Error sending data: {e}")

def send_status_to_server(status):
    data = {
        'status': status,
        'timestamp': str(datetime.datetime.now())
    }
    try:
        requests.post('http://localhost:3000/status', json=data)
    except Exception as e:
        print(f"Error sending status: {e}")

def ask_google_gemini(query):
    client = genai.Client(api_key=GOOGLE_API_KEY)

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents="Answer in only one short sentence:" + query,
    )
    print(response.text)
    return response.text

# Weather Function (with forecast)
def get_weather_and_forecast(city):
    base_url = "http://api.weatherapi.com/v1/"

    try:
        # Fetch current weather
        current_response = requests.get(f'{base_url}current.json?key={WEATHER_API_KEY}&q={city}&aqi=no')
        current_data = current_response.json()

        # Fetch 3-day forecast
        forecast_response = requests.get(f'{base_url}forecast.json?key={WEATHER_API_KEY}&q={city}&days=3&aqi=no')
        forecast_data = forecast_response.json()

        if "error" in current_data or "error" in forecast_data:
            print("Error fetching weather data.")
            return None

        # Extract relevant current weather details
        weather = current_data['current'].get('condition', {}).get('text', 'No weather data available')
        temperature = current_data['current'].get('temp_c', 'N/A')
        icon_url = current_data['current'].get('condition', {}).get('icon', '')

        # Extract 3-day forecast
        forecast = []
        for day in forecast_data['forecast']['forecastday']:
            date = day['date']
            day_weather = day['day']['condition']['text']
            day_icon = day['day']['condition']['icon']
            day_temp = f"{day['day']['maxtemp_c']}°C / {day['day']['mintemp_c']}°C"
            forecast.append({
                'date': date,
                'weather': day_weather,
                'temperature': day_temp,
                'icon': day_icon
            })

        return {
            'current': f"Weather in {city}: {weather}, {temperature}°C",
            'icon': icon_url,
            'forecast': forecast
        }
    except requests.exceptions.RequestException as e:
        print(f"Error getting weather data: {e}")
        return None

# Function to handle weather command and send data
def talk_weather(city):
    weather_data = get_weather_and_forecast(city)
    if weather_data and isinstance(weather_data, dict):
        weather_text = weather_data.get("current")
        weather_icon = weather_data.get("icon", "")
        forecast = weather_data.get("forecast", [])

        if weather_text:
            talk(weather_text)
        else:
            talk("Sorry, I couldn't get the current weather.")

        data = {
            'command': 'weather',
            'response': weather_text,
            'icon': weather_icon,
            'forecast': forecast,
            'who_is_talking': 'NOVA',
            'is_user_talking': False,
            'isWeather': True,
            'timestamp': str(datetime.datetime.now())
        }
        send_data_to_server(data)
    else:
        talk("Sorry, I couldn't fetch the weather right now.")
        data = {
            'command': 'weather',
            'response': "No weather data available.",
            'forecast': [],
            'who_is_talking': 'NOVA',
            'is_user_talking': False,
            'isWeather': True,
            'timestamp': str(datetime.datetime.now())
        }
        send_data_to_server(data)

# Speech Function
def talk(text):
    tts = gTTS(text)

    fp = io.BytesIO()
    tts.write_to_fp(fp)
    fp.seek(0)

    # Play the audio using pydub
    audio = AudioSegment.from_file(fp, format="mp3")
    play(audio)

def take_command():
    try:
        command = ""
        with sr.Microphone() as source:
            print("Listening...")
            voice = listener.listen(source)  # Capture audio from microphone
            command = listener.recognize_google(voice)
            command = command.lower()

            print(f"You said: {command}")

            # Only proceed if 'nova' is in the command
            if 'nova' in command:
                command = command.replace('nova', '')
                print(command)
                return command
            else:
                return ""

    except:
        pass
    return command

def run_nova():

    send_status_to_server("listening")
    command = take_command()
    respose = ""
    if not command:
        return

    data = {'command': command, 'who_is_talking': 'User', 'response': respose, 'is_user_talking': True,
            'timestamp': str(datetime.datetime.now())}

    send_status_to_server("processing")

    # Execute commands based on the user's speech
    if 'play' in command:
        song = command.replace('play', '').strip()
        talk(f"Playing {song} on Spotify")

        results = sp.search(q=song, limit=1, type='track')
        if results['tracks']['items']:
            track_uri = results['tracks']['items'][0]['uri']
            sp.start_playback(uris=[track_uri])
            send_status_to_server("responding")
        else:
            talk("I couldn't find that song on Spotify.")


    elif 'time' in command:
        time_now = datetime.datetime.now().strftime('%I:%M %p')
        talk("Current time is " + time_now)
        data['response'] = time_now
        data['who_is_talking'] = 'NOVA'
        data['is_user_talking'] = False
        send_status_to_server("responding")


    elif 'weather' in command:
        if 'weather in' in command:
            city = command.replace('weather in', '').strip()
        else:
            city = get_location()
        if city:
            weather_data = get_weather_and_forecast(city)
            if weather_data:
                # Speak only the current weather
                talk(weather_data["current"])
                data['response'] = weather_data["current"]
                data['forecast'] = weather_data.get("forecast", []) if weather_data else []
            else:
                talk("Sorry, I couldn't get the weather right now.")
                data['response'] = "No weather data available."
                data['forecast'] = []
            data['who_is_talking'] = 'NOVA'
            data['is_user_talking'] = False
            data['isWeather'] = True
            send_status_to_server("responding")
        else:
            talk("Sorry, I couldn't detect your location.")
            data['response'] = "Location detection failed."
            data['who_is_talking'] = 'NOVA'
            data['is_user_talking'] = False
            data['isWeather'] = True
            send_status_to_server("responding")


    elif 'joke' in command:
        joke = pyjokes.get_joke()
        talk(joke)
        data['response'] = joke
        data['who_is_talking'] = 'NOVA'
        data['is_user_talking'] = False
        send_status_to_server("responding")

    elif 'who' in command or 'what' in command or 'how' in command or 'why' in command or 'do you know' in command:

        # If NOVA  can't answer, ask Google Gemini
        gemini_response = ask_google_gemini(command)
        talk(gemini_response)
        data['response'] = gemini_response
        data['who_is_talking'] = 'NOVA'
        data['is_user_talking'] = False
        send_status_to_server("responding")
    

    elif 'calendar' in command:
        if 'add' in command:
            # Use Gemini to parse the calendar command
            prompt = f"""Parse this calendar command into a JSON object with the following structure:
{{
  \"title\": \"event title\",
  \"date\": \"YYYY-MM-DD\",
  \"time\": \"HH:MM\",
  \"description\": \"event description\"
}}

Rules:
- Convert all dates to YYYY-MM-DD format
- Convert all times to 24-hour format (HH:MM)
- If no time is specified, use \"00:00\"
- If no description is provided, use an empty string
- For relative dates like \"tomorrow\", calculate the actual date
- For dates without year, use the current year
- For times like \"2:30 pm\", convert to \"14:30\"

Command: {command}

Return only the JSON object, nothing else."""

            try:
                # Get structured data from Gemini
                gemini_response = ask_google_gemini(prompt)
                import json
                # Try to extract JSON from Gemini's response
                start = gemini_response.find('{')
                end = gemini_response.rfind('}') + 1
                json_str = gemini_response[start:end]
                event_data = json.loads(json_str)
                # Add the event to the calendar
                result = add_calendar_event(
                    title=event_data['title'],
                    date=event_data['date'],
                    time=event_data['time'],
                    description=event_data['description']
                )
                # Create a natural language response
                response = f"I've added {event_data['title']} to your calendar"
                if event_data['time'] != "00:00":
                    response += f" at {event_data['time']}"
                response += f" on {event_data['date']}"
                if event_data['description']:
                    response += f". {event_data['description']}"
                talk(response)
                data['response'] = response
                data['who_is_talking'] = 'NOVA'
                data['is_user_talking'] = False
            except json.JSONDecodeError as e:
                talk("I'm sorry, I couldn't understand the calendar details. Please try again.")
                print(f"Error parsing Gemini response: {e}\nGemini response: {gemini_response}")
                return
            except Exception as e:
                talk("I'm sorry, I couldn't add the event to your calendar.")
                print(f"Error adding calendar event: {e}")
                return

        elif 'show' in command or 'list' in command:
            # TODO: Implement showing calendar events
            talk("I'll show you your calendar events.")
            data['response'] = "Showing calendar events"
            data['who_is_talking'] = 'NOVA'
            data['is_user_talking'] = False

        else:
            talk("I can help you add events to your calendar or show your schedule. What would you like to do?")
            data['response'] = "Calendar help message"
            data['who_is_talking'] = 'NOVA'
            data['is_user_talking'] = False

    elif 'shut down' in command or 'shutdown' in command:
        sys.exit(0)

    else:
        gemini_response = ask_google_gemini(command)
        talk(gemini_response)
        data['response'] = gemini_response
        data['who_is_talking'] = 'NOVA'
        data['is_user_talking'] = False
        send_status_to_server("responding")

    send_data_to_server(data)
    send_status_to_server("idle")

# Main loop
while not exit_flag.is_set():
    run_nova()
