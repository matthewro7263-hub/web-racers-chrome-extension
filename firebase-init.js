import { initializeApp } from "./lib/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from "./lib/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp } from "./lib/firebase-firestore.js";

window.firebaseModular = {
    initializeApp, getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged,
    getFirestore, collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp
};
