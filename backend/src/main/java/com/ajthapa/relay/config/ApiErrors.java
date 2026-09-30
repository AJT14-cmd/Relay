package com.ajthapa.relay.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.ErrorResponse;
import org.springframework.dao.DataIntegrityViolationException;
import java.sql.SQLException;

@RestControllerAdvice
public class ApiErrors {
    private static final Logger log = LoggerFactory.getLogger(ApiErrors.class);
    @ExceptionHandler(ResponseStatusException.class)
    ProblemDetail status(ResponseStatusException error) {
        return ProblemDetail.forStatusAndDetail(error.getStatusCode(), error.getReason() == null ? "Request failed" : error.getReason());
    }
    @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    ProblemDetail invalid(Exception error) {
        // Do not echo rejected inputs: a future field could contain a secret.
        return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Invalid request: check required fields and value types");
    }
    @ExceptionHandler(Exception.class)
    ProblemDetail unexpected(Exception error) {
        if (error instanceof ErrorResponse response) {
            return ProblemDetail.forStatusAndDetail(response.getStatusCode(), "Request could not be handled at this route");
        }
        if (error instanceof DataIntegrityViolationException) {
            Throwable cause = error;
            while (cause != null) {
                if (cause instanceof SQLException sql && sql.getSQLState() != null && sql.getSQLState().startsWith("22"))
                    return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Input contains a value PostgreSQL cannot store");
                cause = cause.getCause();
            }
        }
        log.error("Unhandled API failure type={}", error.getClass().getSimpleName());
        return ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR, "An internal error occurred");
    }
}
