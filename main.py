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

# Initialize Pam's voice
engine = pyttsx3.init()
voices = engine.getProperty('voices')
engine.setProperty('voice', voices[1].id)  # Pam's voice
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

        # Check if the API response is valid
        if "error" in data:
            print("Error fetching weather data.")
            return None

        # Extract relevant weather details from the response
        weather = data['current'].get('condition', {}).get('text', 'No weather data available')
        temperature = data['current'].get('temp_c', 'N/A')

        return f"Weather in {city}: {weather}, {temperature}°C"
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


def talk_weather(city):
    weather_report = get_weather(city)
    weather_report = weather_data
    talk(weather_report)


def ask_google_gemini(query):
    client = genai.Client(api_key=GOOGLE_API_KEY)

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents="Answer in only one short sentence:" + query,
    )
    print(response.text)
    return response.text


# Speech Function
def talk(text):
    tts = gTTS(text)

    fp = io.BytesIO()
    tts.write_to_fp(fp)
    fp.seek(0)

    # Play the audio using pydub
    audio = AudioSegment.from_file(fp, format="mp3")
    play(audio)


listener = sr.Recognizer()


def take_command():
    try:
        command = ""
        with sr.Microphone() as source:
            print("Listening...")
            voice = listener.listen(source)  # Capture audio from microphone
            command = listener.recognize_google(voice)
            command = command.lower()

            print(f"You said: {command}")

            # Only proceed if 'Pam' is in the command
            if 'pam' in command:
                command = command.replace('pam', '')
                print(command)
                return command
            else:
                return ""

    except:
        pass
    return command

def run_pam():
    command = take_command()
    respose = ""
    if not command:
        return

    data = {'command': command, 'who_is_talking': 'User', 'response': respose, 'is_user_talking': True,
            'timestamp': str(datetime.datetime.now())}

    # Execute commands based on the user's speech
    if 'play' in command:
        song = command.replace('play', '').strip()
        talk(f"Playing {song} on Spotify")

        results = sp.search(q=song, limit=1, type='track')
        if results['tracks']['items']:
            track_uri = results['tracks']['items'][0]['uri']
            sp.start_playback(uris=[track_uri])
        else:
            talk("I couldn't find that song on Spotify.")


    elif 'time' in command:
        time_now = datetime.datetime.now().strftime('%I:%M %p')
        talk("Current time is " + time_now)

    elif 'weather' in command:
        if 'weather in' in command:
            city = command.replace('weather in', '').strip()
        else:
            city = get_location()
        if city:
            weather_report = get_weather(city)
            if weather_report:
                talk(weather_report)
                data['response'] = weather_report
                data['who_is_talking'] = 'Pam'
                data['is_user_talking'] = False
            else:
                talk("Sorry, I couldn't fetch the weather right now.")
        else:
            talk("Sorry, I couldn't detect your location.")

    elif 'joke' in command:
        joke = pyjokes.get_joke()
        talk(joke)
        data['response'] = joke
        data['who_is_talking'] = 'Pam'
        data['is_user_talking'] = False

    elif 'who' in command or 'what' in command or 'how' in command or 'why' in command or 'do you know' in command:
        # If Pam can't answer, ask Google Gemini
        gemini_response = ask_google_gemini(command)
        talk(gemini_response)
        data['response'] = gemini_response
        data['who_is_talking'] = 'Pam'
        data['is_user_talking'] = False

    else:
        gemini_response = ask_google_gemini(command)
        talk(gemini_response)
        data['response'] = gemini_response
        data['who_is_talking'] = 'Pam'
        data['is_user_talking'] = False

    send_data_to_server(data)


while True:
    run_pam()